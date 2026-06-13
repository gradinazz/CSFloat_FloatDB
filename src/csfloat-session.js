'use strict';

/**
 * CSFloatSession
 *
 * Получает CSFloat session cookie (JWT) через Steam OpenID авторизацию.
 * Standalone-версия для FloatDB проекта — использует SteamCommunity из npm.
 *
 * Flow:
 * 1. Steam login (SteamCommunity)
 * 2. GET Steam OpenID page → парсим openidparams + nonce
 * 3. POST Steam OpenID approval (multipart/form-data) → 302 redirect
 * 4. GET CSFloat auth endpoint → Set-Cookie: session=JWT
 */

const SteamCommunity = require('steamcommunity');
const SteamTotp = require('steam-totp');
const axios = require('axios');

const STEAM_OPENID_URL = 'https://steamcommunity.com/openid/login';
const CSFLOAT_RETURN_TO = 'https://csgofloat.com';
const CSFLOAT_REALM = 'https://csgofloat.com';
const CSFLOAT_AUTH_URL = 'https://csfloat.com/api/v1/auth/login';

class CSFloatSession {
    constructor(accountConfig) {
        this.account = accountConfig;
        this.community = new SteamCommunity();
        this.sessionJWT = null;
        this.loggedIn = false;
        this.steamCookies = { steamLoginSecure: '', sessionid: '' };
    }

    /**
     * Полный flow: Steam login → OpenID → CSFloat JWT
     * @returns {Promise<string>} JWT session token
     */
    async getSession() {
        if (!this.loggedIn) {
            await this._steamLogin();
        }

        const jwt = await this._obtainCSFloatJWT();
        if (!jwt) {
            throw new Error('Failed to obtain CSFloat session JWT');
        }

        this.sessionJWT = jwt;
        return jwt;
    }

    /**
     * Steam login через SteamCommunity
     */
    async _steamLogin() {
        return new Promise((resolve, reject) => {
            const twoFactorCode = SteamTotp.generateAuthCode(this.account.shared_secret);

            this.community.login({
                accountName: this.account.steam_login,
                password: this.account.steam_password,
                twoFactorCode,
                disableMobile: true
            }, (err, sessionID, cookies, steamguard, oAuthToken) => {
                if (err) {
                    return reject(new Error(`Steam login failed: ${err.message}`));
                }
                // Parse cookies from callback (array of "name=value; ..." strings)
                this.steamCookies = this._parseCookiesFromArray(cookies);
                console.log(`[Session] Steam login OK: ${this.account.account_name}`);
                this.loggedIn = true;
                resolve();
            });
        });
    }

    /**
     * Получает CSFloat JWT через Steam OpenID flow
     */
    async _obtainCSFloatJWT() {
        const steamCookies = this.steamCookies;
        if (!steamCookies.steamLoginSecure || !steamCookies.sessionid) {
            throw new Error('Missing Steam cookies (steamLoginSecure or sessionid)');
        }

        const httpClient = axios.create({
            maxRedirects: 0,
            validateStatus: (status) => status < 500,
            timeout: 30000,
            headers: {
                'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/148.0.0.0 Safari/537.36'
            }
        });

        // 1. GET Steam OpenID page
        const openIdParams = new URLSearchParams({
            'openid.ns': 'http://specs.openid.net/auth/2.0',
            'openid.mode': 'checkid_setup',
            'openid.return_to': CSFLOAT_RETURN_TO,
            'openid.realm': CSFLOAT_REALM,
            'openid.identity': 'http://specs.openid.net/auth/2.0/identifier_select',
            'openid.claimed_id': 'http://specs.openid.net/auth/2.0/identifier_select'
        });

        const openIdPageUrl = `${STEAM_OPENID_URL}?${openIdParams.toString()}`;
        const pageResp = await httpClient.get(openIdPageUrl, {
            headers: {
                Cookie: this._buildCookieHeader({
                    steamLoginSecure: steamCookies.steamLoginSecure,
                    sessionid: steamCookies.sessionid
                })
            }
        });

        if (pageResp.status === 302 && pageResp.headers.location) {
            return await this._handleOpenIDCallback(httpClient, pageResp.headers.location);
        }

        if (pageResp.status !== 200) {
            throw new Error(`Steam OpenID page returned ${pageResp.status}`);
        }

        // 2. Parse form
        const { openidparams, nonce } = this._parseOpenIDPage(pageResp.data);
        if (!openidparams || !nonce) {
            throw new Error('Failed to parse OpenID form (openidparams/nonce)');
        }

        const browserId = this._extractSetCookie(pageResp.headers, 'browserid');

        // 3. POST Steam OpenID approval (multipart/form-data)
        const postCookies = {
            steamLoginSecure: steamCookies.steamLoginSecure,
            sessionid: steamCookies.sessionid,
            sessionidSecureOpenIDNonce: nonce
        };
        if (browserId) postCookies.browserid = browserId;

        const boundary = '----WebKitFormBoundary' + Math.random().toString(36).slice(2);
        const multipartBody = [
            `--${boundary}`,
            'Content-Disposition: form-data; name="action"', '', 'steam_openid_login',
            `--${boundary}`,
            'Content-Disposition: form-data; name="openid.mode"', '', 'checkid_setup',
            `--${boundary}`,
            'Content-Disposition: form-data; name="openidparams"', '', openidparams,
            `--${boundary}`,
            'Content-Disposition: form-data; name="nonce"', '', nonce,
            `--${boundary}--`, ''
        ].join('\r\n');

        const postResp = await httpClient.post(STEAM_OPENID_URL, multipartBody, {
            headers: {
                'Content-Type': `multipart/form-data; boundary=${boundary}`,
                Cookie: this._buildCookieHeader(postCookies),
                Referer: openIdPageUrl,
                Origin: 'https://steamcommunity.com'
            }
        });

        if (postResp.status !== 302 || !postResp.headers.location) {
            throw new Error(`Steam OpenID POST returned ${postResp.status} (expected 302)`);
        }

        // 4. Handle redirect → CSFloat auth
        return await this._handleOpenIDCallback(httpClient, postResp.headers.location);
    }

    /**
     * Парсит cookies из массива строк (формат SteamCommunity callback).
     * Ищет steamLoginSecure для домена steamcommunity.com и sessionid.
     */
    _parseCookiesFromArray(cookieStrings) {
        const result = { steamLoginSecure: '', sessionid: '' };
        if (!Array.isArray(cookieStrings)) return result;

        for (const raw of cookieStrings) {
            const nameValue = raw.split(';')[0]; // "name=value"
            const domainMatch = raw.match(/Domain=([^;]+)/i);
            const domain = domainMatch ? domainMatch[1].trim() : '';

            if (nameValue.startsWith('steamLoginSecure=') && domain.includes('steamcommunity.com')) {
                result.steamLoginSecure = nameValue.slice('steamLoginSecure='.length);
            }
            if (nameValue.startsWith('sessionid=') && domain.includes('steamcommunity.com')) {
                result.sessionid = nameValue.slice('sessionid='.length);
            }
        }
        return result;
    }

    async _handleOpenIDCallback(httpClient, callbackUrl) {
        const url = new URL(callbackUrl);
        const openIdResponseParams = {};
        for (const [key, value] of url.searchParams) {
            if (key.startsWith('openid.')) {
                openIdResponseParams[key] = value;
            }
        }

        if (!openIdResponseParams['openid.sig']) {
            throw new Error('No openid.sig in callback — Steam did not approve');
        }

        const authParams = new URLSearchParams(openIdResponseParams);
        const authUrl = `${CSFLOAT_AUTH_URL}?${authParams.toString()}`;

        const authResp = await httpClient.get(authUrl, {
            headers: {
                Accept: 'application/json, text/plain, */*',
                Referer: callbackUrl
            }
        });

        if (authResp.status !== 200) {
            throw new Error(`CSFloat auth returned ${authResp.status}`);
        }

        const sessionJWT = this._extractSetCookie(authResp.headers, 'session');
        if (!sessionJWT) {
            throw new Error('No session cookie in CSFloat auth response');
        }

        console.log(`[Session] CSFloat JWT obtained (${sessionJWT.length} chars)`);
        return sessionJWT;
    }

    _parseOpenIDPage(html) {
        const paramsMatch = html.match(/name="openidparams"\s+value="([^"]+)"/);
        const nonceMatch = html.match(/name="nonce"\s+value="([^"]+)"/);
        return {
            openidparams: paramsMatch ? paramsMatch[1] : null,
            nonce: nonceMatch ? nonceMatch[1] : null
        };
    }

    _extractSetCookie(headers, cookieName) {
        const setCookies = headers['set-cookie'];
        if (!setCookies) return null;
        const arr = Array.isArray(setCookies) ? setCookies : [setCookies];
        for (const sc of arr) {
            if (sc.startsWith(`${cookieName}=`)) {
                return sc.split(';')[0].slice(cookieName.length + 1);
            }
        }
        return null;
    }

    _buildCookieHeader(cookieObj) {
        return Object.entries(cookieObj)
            .map(([k, v]) => `${k}=${v}`)
            .join('; ');
    }
}

module.exports = CSFloatSession;
