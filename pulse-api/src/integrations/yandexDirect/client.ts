// @ts-nocheck -- recovered unchanged from the deployed JavaScript; original TS is unavailable.
const DIRECT_API_URL = 'https://api.direct.yandex.com/json/v5';
export class YandexDirectError extends Error {
    status;
    requestId;
    constructor(message, status, requestId) {
        super(message);
        this.status = status;
        this.requestId = requestId;
        this.name = 'YandexDirectError';
    }
}
export async function yandexDirectRequest(config, service, body) {
    const headers = {
        Authorization: `Bearer ${config.token}`,
        'Accept-Language': 'ru',
        'Content-Type': 'application/json; charset=utf-8',
    };
    if (config.clientLogin)
        headers['Client-Login'] = config.clientLogin;
    const response = await fetch(`${DIRECT_API_URL}/${service}`, {
        method: 'POST',
        headers,
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(20_000),
    });
    const requestId = response.headers.get('RequestId');
    const payload = await response.json().catch(() => null);
    if (!response.ok || payload?.error) {
        const apiError = payload?.error;
        const message = apiError?.error_detail || apiError?.error_string || `HTTP ${response.status}`;
        throw new YandexDirectError(message, response.status, requestId);
    }
    return payload;
}
export async function checkYandexDirect(config) {
    if (config.clientLogin) {
        const payload = await yandexDirectRequest(config, 'campaigns', {
            method: 'get',
            params: {
                SelectionCriteria: {},
                FieldNames: ['Id', 'Name', 'State', 'Status'],
                Page: { Limit: 1 },
            },
        });
        return {
            mode: 'campaigns',
            campaignCountInProbe: payload?.result?.Campaigns?.length ?? 0,
            limitedBy: payload?.result?.LimitedBy ?? null,
        };
    }
    const payload = await yandexDirectRequest(config, 'clients', {
        method: 'get',
        params: {
            SelectionCriteria: { Archived: 'NO' },
            FieldNames: ['ClientId', 'Login', 'Name'],
            Page: { Limit: 1 },
        },
    });
    return {
        mode: 'clients',
        clientCountInProbe: payload?.result?.Clients?.length ?? 0,
        limitedBy: payload?.result?.LimitedBy ?? null,
    };
}
