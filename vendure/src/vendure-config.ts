import { AssetServerPlugin } from '@vendure/asset-server-plugin';
import {
    DefaultSchedulerPlugin,
    DefaultSearchPlugin,
    dummyPaymentHandler,
    VendureConfig,
    defaultShippingCalculator,
} from '@vendure/core';
import { AdminUiPlugin } from '@vendure/admin-ui-plugin';
import { defaultEmailHandlers, EmailPlugin, FileBasedTemplateLoader } from '@vendure/email-plugin';
import { GraphiqlPlugin } from '@vendure/graphiql-plugin';
import { BullMQJobQueuePlugin } from '@vendure/job-queue-plugin/package/bullmq';
import 'dotenv/config';
import path from 'path';
import axios from 'axios';
import { mercadoPagoHandler } from './plugins/mercadopago-handler';
import { fedexShippingCalculator } from './plugins/fedex-shipping-calculator';
import { skydropxShippingCalculator } from './plugins/skydropx-shipping-calculator';

const IS_LOCAL = process.env.APP_ENV === 'local';
const serverPort = +process.env.PORT || 3000;

export const config: VendureConfig = {
    apiOptions: {
        port: serverPort,
        adminApiPath: 'admin-api',
        shopApiPath: 'shop-api',
        middleware: [
            {
                handler: async (req: any, res: any, next: any) => {
                    if (req.path !== '/mercadopago-webhook') {
                        return next();
                    }

                    if (req.method === 'GET') {
                        return res.status(200).send('OK');
                    }

                    if (req.method !== 'POST') {
                        return res.status(200).send('OK');
                    }

                    // Respond immediately to Mercado Pago (they require fast response)
                    res.status(200).send('OK');

                    // Process webhook async after responding
                    try {
                        const body = req.body || {};
                        console.log(`[MercadoPagoWebhook] Received:`, JSON.stringify(body));

                        // Determine payment ID from notification format
                        let paymentId = null;

                        if (body.type === 'payment' && body.data?.id) {
                            // Webhook format: { type: "payment", data: { id: "123" } }
                            paymentId = body.data.id;
                        } else if (body.topic === 'payment' && body.resource) {
                            // IPN format: { topic: "payment", resource: "https://.../payments/123" }
                            paymentId = body.resource.split('/').pop();
                        } else {
                            // Ignore merchant_order and other notification types
                            console.log(`[MercadoPagoWebhook] Ignoring: topic=${body.topic || body.type}`);
                            return;
                        }

                        if (!paymentId) {
                            console.log(`[MercadoPagoWebhook] No payment ID found`);
                            return;
                        }

                        console.log(`[MercadoPagoWebhook] Processing payment: ${paymentId}`);

                        // Get DB connection
                        const dataSource = req.app?.get?.('TypeORMConnection') || req.app?.get?.('DataSource');
                        if (!dataSource) {
                            console.error('[MercadoPagoWebhook] No DataSource found');
                            return;
                        }

                        // Find access token from payment methods
                        const pms = await dataSource.query(
                            `SELECT "handler" FROM "payment_method" WHERE "handler"::text LIKE '%mercado-pago%'`
                        );
                        let accessToken = '';
                        for (const pm of pms) {
                            try {
                                const h = typeof pm.handler === 'string' ? JSON.parse(pm.handler) : pm.handler;
                                const t = h?.args?.find((a: any) => a.name === 'accessToken');
                                if (t) { accessToken = t.value; break; }
                            } catch {}
                        }

                        if (!accessToken) {
                            console.error('[MercadoPagoWebhook] No access token found');
                            return;
                        }

                        // Verify payment with Mercado Pago API
                        const mp = await axios.get(
                            `https://api.mercadopago.com/v1/payments/${paymentId}`,
                            { headers: { Authorization: `Bearer ${accessToken}` } }
                        );

                        const { status, external_reference } = mp.data;
                        console.log(`[MercadoPagoWebhook] Payment ${paymentId}: status=${status}, order=${external_reference}`);

                        if (status === 'approved' && external_reference) {
                            const orders = await dataSource.query(
                                `SELECT "id", "state" FROM "order" WHERE "code" = $1`, [external_reference]
                            );

                            if (orders.length > 0 && orders[0].state === 'PaymentAuthorized') {
                                // Settle the payment via raw SQL
                                await dataSource.query(
                                    `UPDATE "payment" SET "state" = 'Settled', "transactionId" = $1 WHERE "orderId" = $2 AND "method" = 'mercado-pago' AND "state" = 'Authorized'`,
                                    [String(paymentId), orders[0].id]
                                );

                                // Transition order via Admin API to fire events (triggers email)
                                try {
                                    const localApi = `http://localhost:${serverPort}/admin-api`;

                                    // Login as superadmin
                                    const loginRes = await axios.post(
                                        localApi,
                                        {
                                            query: `mutation { login(username: "${process.env.SUPERADMIN_USERNAME}", password: "${process.env.SUPERADMIN_PASSWORD}") { ... on CurrentUser { id } ... on InvalidCredentialsError { message } } }`
                                        },
                                        { headers: { 'Content-Type': 'application/json' } }
                                    );

                                    const setCookies = loginRes.headers['set-cookie'] || [];
                                    const cookieStr = setCookies.map((c: string) => c.split(';')[0]).join('; ');

                                    // Transition to PaymentSettled via Admin API (fires OrderStateTransitionEvent → email)
                                    const transitionRes = await axios.post(
                                        localApi,
                                        {
                                            query: `mutation { transitionOrderToState(id: "${orders[0].id}", state: "PaymentSettled") { ... on Order { id state } ... on OrderStateTransitionError { errorCode message transitionError } } }`
                                        },
                                        {
                                            headers: {
                                                'Content-Type': 'application/json',
                                                'Cookie': cookieStr,
                                            }
                                        }
                                    );

                                    const transResult = transitionRes.data?.data?.transitionOrderToState;
                                    if (transResult?.state === 'PaymentSettled') {
                                        console.log(`[MercadoPagoWebhook] Order ${external_reference} → PaymentSettled via Admin API (email will send)`);
                                    } else {
                                        console.log(`[MercadoPagoWebhook] Admin API transition result:`, JSON.stringify(transResult));
                                        // Fallback: set via raw SQL (email won't send but order is settled)
                                        await dataSource.query(
                                            `UPDATE "order" SET "state" = 'PaymentSettled' WHERE "id" = $1 AND "state" = 'PaymentAuthorized'`,
                                            [orders[0].id]
                                        );
                                        console.log(`[MercadoPagoWebhook] Order ${external_reference} → PaymentSettled via fallback SQL`);
                                    }
                                } catch (apiErr: any) {
                                    console.error(`[MercadoPagoWebhook] Admin API error: ${apiErr.message}`);
                                    // Fallback: raw SQL
                                    await dataSource.query(
                                        `UPDATE "order" SET "state" = 'PaymentSettled' WHERE "id" = $1 AND "state" = 'PaymentAuthorized'`,
                                        [orders[0].id]
                                    );
                                    console.log(`[MercadoPagoWebhook] Order ${external_reference} → PaymentSettled via fallback SQL`);
                                }
                            } else if (orders.length > 0) {
                                console.log(`[MercadoPagoWebhook] Order ${external_reference} already in state: ${orders[0].state}`);
                            } else {
                                console.log(`[MercadoPagoWebhook] Order not found: ${external_reference}`);
                            }
                        }
                    } catch (err: any) {
                        console.error(`[MercadoPagoWebhook] Error: ${err.message}`);
                    }
                },
                route: '/',
                beforeListen: true,
            },
        ],
        cors: {
            origin: [
                'https://dhskateshop.com',
                'http://localhost:3001',
                'https://www.dhskateshop.com'
            ],
            credentials: true,
        },
        trustProxy: IS_LOCAL ? false : 1,
        ...(IS_LOCAL ? {
            adminApiDebug: true,
            shopApiDebug: true,
        } : {}),
    },
    authOptions: {
        tokenMethod: ['bearer', 'cookie'],
        superadminCredentials: {
            identifier: process.env.SUPERADMIN_USERNAME,
            password: process.env.SUPERADMIN_PASSWORD,
        },
        cookieOptions: {
            secret: process.env.COOKIE_SECRET,
            domain: '.dhskateshop.com',
            sameSite: 'none',
            secure: true,
        },
    },
    dbConnectionOptions: {
        type: 'postgres',
        synchronize: true,
        migrations: [path.join(__dirname, './migrations/*.+(js|ts)')],
        logging: false,
        database: process.env.DB_NAME,
        schema: process.env.DB_SCHEMA,
        host: process.env.DB_HOST,
        port: +process.env.DB_PORT,
        username: process.env.DB_USERNAME,
        password: process.env.DB_PASSWORD,
    },
    paymentOptions: {
        paymentMethodHandlers: [dummyPaymentHandler, mercadoPagoHandler],
    },
    shippingOptions: {
        shippingCalculators: [defaultShippingCalculator, fedexShippingCalculator, skydropxShippingCalculator],
    },
    customFields: {},
    plugins: [
        BullMQJobQueuePlugin.init({
            connection: {
                port: 6379,
                host: process.env.REDIS_HOST,
                password: process.env.REDIS_PASSWORD,
                maxRetriesPerRequest: null
            },
        }),
        GraphiqlPlugin.init(),
        AssetServerPlugin.init({
            route: 'assets',
            assetUploadDir: IS_LOCAL ? path.join(__dirname, '../static/assets') : '/usr/src/app/assets',
            assetUrlPrefix: `https://${process.env.VENDURE_HOST}/assets/`,
        }),
        DefaultSchedulerPlugin.init(),
        DefaultSearchPlugin.init({ bufferUpdates: false, indexStockStatus: true }),
        EmailPlugin.init({
            handlers: defaultEmailHandlers,
            templateLoader: new FileBasedTemplateLoader(path.join(__dirname, '../static/email/templates')),
            transport: {
                type: 'smtp',
                host: 'smtp.gmail.com',
                port: 465,
                secure: true,
                auth: {
                    user: process.env.SMTP_USER,
                    pass: process.env.SMTP_PASS,
                },
            },
            globalTemplateVars: {
                fromAddress: `"DH Skate Shop" <${process.env.SMTP_USER}>`,
                verifyEmailAddressUrl: 'https://dhskateshop.com/verify',
                passwordResetUrl: 'https://dhskateshop.com/password-reset',
                changeEmailAddressUrl: 'https://dhskateshop.com/verify-email-address-change',
            },
        }),
        AdminUiPlugin.init({
            route: 'dashboard',
            port: 3002,
            adminUiConfig: {
                apiHost: 'https://vendure.dhskateshop.com',
                apiPort: 443,
            },
        }),
    ],
};