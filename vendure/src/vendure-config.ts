import { AssetServerPlugin } from '@vendure/asset-server-plugin';
import {
    DefaultSchedulerPlugin,
    DefaultSearchPlugin,
    dummyPaymentHandler,
    VendureConfig
} from '@vendure/core';
import { AdminUiPlugin } from '@vendure/admin-ui-plugin';
import { defaultEmailHandlers, EmailPlugin, FileBasedTemplateLoader } from '@vendure/email-plugin';
import { GraphiqlPlugin } from '@vendure/graphiql-plugin';
import { BullMQJobQueuePlugin } from '@vendure/job-queue-plugin/package/bullmq';
import 'dotenv/config';
import path from 'path';
import { mercadoPagoHandler } from './plugins/mercadopago-handler';

const IS_LOCAL = process.env.APP_ENV === 'local';
const serverPort = +process.env.PORT || 3000;

export const config: VendureConfig = {
    apiOptions: {
        port: serverPort,
        adminApiPath: 'admin-api',
        shopApiPath: 'shop-api',
        
        cors: {
        origin: [
            'https://dhskateshop.com',
            'http://localhost:3001',
            'https://www.dhskateshop.com'
        ],
        credentials: true,
        },
        trustProxy: IS_LOCAL ? false : 1,
        // The following options are useful in development mode,
        // but are best turned off for production for security
        // reasons.
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
        // See the README.md "Migrations" section for an explanation of
        // the `synchronize` and `migrations` options.
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
    // When adding or altering custom field definitions, the database will
    // need to be updated. See the "Migrations" section in README.md.
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
            // For local dev, the correct value for assetUrlPrefix should
            // be guessed correctly, but for production it will usually need
            // to be set manually to match your production url.
            assetUrlPrefix: `https://${process.env.VENDURE_HOST}/assets/`,
        }),
        DefaultSchedulerPlugin.init(),
        DefaultSearchPlugin.init({ bufferUpdates: false, indexStockStatus: true }),
        EmailPlugin.init({
            devMode: true,
            outputPath: path.join(__dirname, '../static/email/test-emails'),
            route: 'mailbox',
            handlers: defaultEmailHandlers,
            templateLoader: new FileBasedTemplateLoader(path.join(__dirname, '../static/email/templates')),
            globalTemplateVars: {
                // The following variables will change depending on your storefront implehmentation.
                // Here we are assuming a storefront running at http://localhost:8080.
                fromAddress: '"example" <noreply@example.com>',
                verifyEmailAddressUrl: 'http://localhost:8080/verify',
                passwordResetUrl: 'http://localhost:8080/password-reset',
                changeEmailAddressUrl: 'http://localhost:8080/verify-email-address-change'
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
