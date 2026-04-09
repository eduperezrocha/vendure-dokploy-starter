import { LanguageCode, ShippingCalculator, Logger } from '@vendure/core';
import axios from 'axios';

const loggerCtx = 'FedExShippingCalculator';

// Cache the OAuth token
let fedexToken: string | null = null;
let tokenExpiry = 0;

async function getFedExToken(clientId: string, clientSecret: string): Promise<string> {
  const now = Date.now();
  if (fedexToken && now < tokenExpiry) {
    return fedexToken;
  }

  const res = await axios.post(
    'https://apis.fedex.com/oauth/token',
    new URLSearchParams({
      grant_type: 'client_credentials',
      client_id: clientId,
      client_secret: clientSecret,
    }),
    { headers: { 'Content-Type': 'application/x-www-form-urlencoded' } }
  );

  fedexToken = res.data.access_token;
  // Token is valid for 1 hour, refresh 5 min early
  tokenExpiry = now + (res.data.expires_in - 300) * 1000;
  return fedexToken!;
}

export const fedexShippingCalculator = new ShippingCalculator({
  code: 'fedex-rates-calculator',
  description: [
    { languageCode: LanguageCode.en, value: 'FedEx Live Rates' },
    { languageCode: LanguageCode.es, value: 'Tarifas FedEx en vivo' },
  ],
  args: {
    clientId: {
      type: 'string',
      label: [{ languageCode: LanguageCode.en, value: 'FedEx Client ID (API Key)' }],
    },
    clientSecret: {
      type: 'string',
      label: [{ languageCode: LanguageCode.en, value: 'FedEx Client Secret' }],
    },
    accountNumber: {
      type: 'string',
      label: [{ languageCode: LanguageCode.en, value: 'FedEx Account Number' }],
    },
    originCountry: {
      type: 'string',
      defaultValue: 'MX',
      label: [{ languageCode: LanguageCode.en, value: 'Origin Country Code' }],
    },
    originPostalCode: {
      type: 'string',
      label: [{ languageCode: LanguageCode.en, value: 'Origin Postal Code' }],
    },
    originState: {
      type: 'string',
      label: [{ languageCode: LanguageCode.en, value: 'Origin State Code' }],
    },
    originCity: {
      type: 'string',
      label: [{ languageCode: LanguageCode.en, value: 'Origin City' }],
    },
    serviceType: {
      type: 'string',
      defaultValue: 'FEDEX_EXPRESS_SAVER',
      label: [{ languageCode: LanguageCode.en, value: 'Service Type' }],
      description: [{ languageCode: LanguageCode.en, value: 'FEDEX_EXPRESS_SAVER, STANDARD_OVERNIGHT, PRIORITY_OVERNIGHT, FEDEX_GROUND, FEDEX_INTERNATIONAL_PRIORITY, or leave empty for cheapest' }],
    },
    fallbackRate: {
      type: 'int',
      defaultValue: 19900,
      label: [{ languageCode: LanguageCode.en, value: 'Fallback Rate (cents)' }],
      ui: { component: 'currency-form-input' },
    },
    taxRate: {
      type: 'int',
      defaultValue: 16,
      label: [{ languageCode: LanguageCode.en, value: 'Tax Rate %' }],
      ui: { component: 'number-form-input', suffix: '%' },
    },
  },

  calculate: async (ctx, order, args) => {
    const shippingAddress = order.shippingAddress;

    if (!shippingAddress?.postalCode || !shippingAddress?.countryCode) {
      return {
        price: 0,
        priceIncludesTax: false,
        taxRate: args.taxRate,
        metadata: { error: 'No shipping address provided' },
      };
    }

    // Calculate total weight (default 500g per item if not set)
    let totalWeightKg = 0;
    for (const line of order.lines) {
      const itemWeightGrams = (line.productVariant as any)?.customFields?.weight || 1500;
      totalWeightKg += (itemWeightGrams / 1000) * line.quantity;
    }
    totalWeightKg = Math.max(totalWeightKg, 0.5);

    try {
      const token = await getFedExToken(args.clientId, args.clientSecret);

      const requestBody: any = {
        accountNumber: { value: args.accountNumber },
        rateRequestControlParameters: {
          returnTransitTimes: true,
        },
        requestedShipment: {
          shipper: {
            address: {
              postalCode: args.originPostalCode,
              stateOrProvinceCode: args.originState,
              city: args.originCity,
              countryCode: args.originCountry,
            },
          },
          recipient: {
            address: {
              postalCode: shippingAddress.postalCode,
              stateOrProvinceCode: shippingAddress.province || '',
              city: shippingAddress.city || '',
              countryCode: shippingAddress.countryCode,
            },
          },
          pickupType: 'DROPOFF_AT_FEDEX_LOCATION',
          rateRequestType: ['ACCOUNT', 'LIST'],
          requestedPackageLineItems: [
            {
              weight: {
                units: 'KG',
                value: Math.round(totalWeightKg * 10) / 10,
              },
              dimensions: {
                length: 30,
                width: 20,
                height: 12,
                units: 'CM',
              },
            },
          ],
        },
      };

      // If a specific service is requested, add it
      if (args.serviceType && args.serviceType !== '') {
        requestBody.requestedShipment.serviceType = args.serviceType;
      }

      const response = await axios.post(
        'https://apis.fedex.com/rate/v1/rates/quotes',
        requestBody,
        {
          headers: {
            'Authorization': `Bearer ${token}`,
            'Content-Type': 'application/json',
            'X-locale': 'es_MX',
          },
        }
      );

      const rateDetails = response.data?.output?.rateReplyDetails;

      if (!rateDetails || rateDetails.length === 0) {
        Logger.warn('No FedEx rates returned', loggerCtx);
        return {
          price: args.fallbackRate,
          priceIncludesTax: false,
          taxRate: args.taxRate,
          metadata: { error: 'No FedEx rates available, using fallback', service: 'Standard Shipping' },
        };
      }

      // Find the best rate
      let bestRate = rateDetails[0];
      let bestPrice = Infinity;

      for (const rate of rateDetails) {
        const shipmentRate = rate.ratedShipmentDetails?.[0];
        const totalCharge = shipmentRate?.totalNetCharge || shipmentRate?.totalNetFedExCharge || 999999;
        if (totalCharge < bestPrice) {
          bestPrice = totalCharge;
          bestRate = rate;
        }
      }

      const shipmentDetail = bestRate.ratedShipmentDetails?.[0];
      const totalCharge = shipmentDetail?.totalNetCharge || shipmentDetail?.totalNetFedExCharge || 0;
      const currency = shipmentDetail?.currency || 'MXN';
      const serviceName = bestRate.serviceName || bestRate.serviceType || 'FedEx';
      const deliveryDate = bestRate.commit?.dateDetail?.dayFormat || '';
      const transitDays = bestRate.commit?.transitDays?.description || '';

      const priceInCents = Math.round(totalCharge * 100);

      Logger.info(`FedEx rate: ${serviceName} = ${totalCharge} ${currency}`, loggerCtx);

      return {
        price: priceInCents,
        priceIncludesTax: false,
        taxRate: args.taxRate,
        metadata: {
          service: serviceName,
          estimatedDelivery: deliveryDate || transitDays,
          totalWeight: `${totalWeightKg} kg`,
          currency,
        },
      };
    } catch (err: any) {
      const errMsg = err.response?.data?.errors?.[0]?.message || err.message;
      Logger.error(`FedEx API error: ${errMsg}`, loggerCtx);

      return {
        price: args.fallbackRate,
        priceIncludesTax: false,
        taxRate: args.taxRate,
        metadata: {
          error: 'FedEx API unavailable, using fallback rate',
          service: 'Standard Shipping (estimated)',
          detail: errMsg,
        },
      };
    }
  },
});