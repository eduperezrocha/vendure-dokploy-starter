import { LanguageCode, ShippingCalculator, Logger } from '@vendure/core';
import axios from 'axios';

const loggerCtx = 'SkydropxShippingCalculator';

// Cache the OAuth token
let skydropxToken: string | null = null;
let tokenExpiry = 0;

async function getToken(clientId: string, clientSecret: string): Promise<string> {
  const now = Date.now();
  if (skydropxToken && now < tokenExpiry) {
    return skydropxToken;
  }

  const res = await axios.post(
    'https://app.skydropx.com/api/v1/oauth/token',
    new URLSearchParams({
      grant_type: 'client_credentials',
      client_id: clientId,
      client_secret: clientSecret,
    }),
    { headers: { 'Content-Type': 'application/x-www-form-urlencoded' } }
  );

  skydropxToken = res.data.access_token;
  const expiresIn = res.data.expires_in || 7200;
  tokenExpiry = now + (expiresIn - 300) * 1000;
  Logger.info(`Got Skydropx token: ${skydropxToken!.slice(0, 10)}...`, loggerCtx);
  return skydropxToken!;
}

export const skydropxShippingCalculator = new ShippingCalculator({
  code: 'skydropx-rates-calculator',
  description: [
    { languageCode: LanguageCode.en, value: 'Skydropx Live Rates' },
    { languageCode: LanguageCode.es, value: 'Tarifas Skydropx en vivo' },
  ],
  args: {
    clientId: {
      type: 'string',
      label: [{ languageCode: LanguageCode.en, value: 'Client ID (API Key)' }],
    },
    clientSecret: {
      type: 'string',
      label: [{ languageCode: LanguageCode.en, value: 'Client Secret' }],
    },
    originPostalCode: {
      type: 'string',
      defaultValue: '20000',
      label: [{ languageCode: LanguageCode.en, value: 'Origin Postal Code' }],
    },
    originState: {
      type: 'string',
      defaultValue: 'Aguascalientes',
      label: [{ languageCode: LanguageCode.en, value: 'Origin State' }],
    },
    originCity: {
      type: 'string',
      defaultValue: 'Aguascalientes',
      label: [{ languageCode: LanguageCode.en, value: 'Origin City' }],
    },
    originNeighborhood: {
      type: 'string',
      defaultValue: 'Centro',
      label: [{ languageCode: LanguageCode.en, value: 'Origin Neighborhood (Colonia)' }],
    },
    preferredCarrier: {
      type: 'string',
      defaultValue: '',
      label: [{ languageCode: LanguageCode.en, value: 'Preferred Carrier (optional)' }],
      description: [{ languageCode: LanguageCode.en, value: 'e.g. fedex, dhl, estafeta, ups — leave empty for cheapest' }],
    },
    fallbackRate: {
      type: 'int',
      defaultValue: 25000,
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

    if (!shippingAddress?.postalCode) {
      return {
        price: 0,
        priceIncludesTax: false,
        taxRate: args.taxRate,
        metadata: { error: 'No shipping address provided' },
      };
    }

    // Calculate total weight (default 1.5kg per item)
    let totalWeightKg = 0;
    for (const line of order.lines) {
      const itemWeightGrams = (line.productVariant as any)?.customFields?.weight || 1500;
      totalWeightKg += (itemWeightGrams / 1000) * line.quantity;
    }
    totalWeightKg = Math.max(totalWeightKg, 0.5);

    try {
      // 1. Get OAuth token
      const token = await getToken(args.clientId, args.clientSecret);

      // 2. Create quotation (V2 format)
      const requestBody: any = {
        quotation: {
          address_from: {
            country_code: 'MX',
            postal_code: args.originPostalCode,
            area_level1: args.originState,
            area_level2: args.originCity,
            area_level3: args.originNeighborhood,
          },
          address_to: {
            country_code: 'MX',
            postal_code: shippingAddress.postalCode,
            area_level1: shippingAddress.province || '',
            area_level2: shippingAddress.city || '',
            area_level3: '',
          },
          parcels: [
            {
              weight: Math.round(totalWeightKg * 10) / 10,
              length: 30,
              width: 20,
              height: 12,
            },
          ],
        },
      };

      // Filter by carrier if specified
      if (args.preferredCarrier) {
        requestBody.quotation.requested_carriers = [args.preferredCarrier.toLowerCase()];
      }

      Logger.info(`Creating Skydropx quotation: ${args.originPostalCode} -> ${shippingAddress.postalCode}`, loggerCtx);

      const createRes = await axios.post(
        'https://app.skydropx.com/api/v2/quotations',
        requestBody,
        {
          headers: {
            'Authorization': `Bearer ${token}`,
            'Content-Type': 'application/json',
          },
        }
      );

      const quotationData = createRes.data;
      const quotationId = quotationData?.id;
      let rates = quotationData?.rates || [];
      let isCompleted = quotationData?.is_completed || false;

      Logger.info(`Quotation created: ${quotationId}, completed: ${isCompleted}, rates: ${rates.length}`, loggerCtx);

      // 3. Poll if not completed yet
      if (!isCompleted && quotationId) {
        let attempts = 0;
        const maxAttempts = 5;

        while (attempts < maxAttempts) {
          await new Promise((r) => setTimeout(r, 2000));
          attempts++;

          const getRes = await axios.get(
            `https://app.skydropx.com/api/v1/quotations/${quotationId}`,
            {
              headers: {
                'Authorization': `Bearer ${token}`,
                'Content-Type': 'application/json',
              },
            }
          );

          const pollData = getRes.data;
          isCompleted = pollData?.is_completed || false;
          rates = pollData?.rates || [];

          Logger.info(`Poll attempt ${attempts}: completed=${isCompleted}, rates=${rates.length}`, loggerCtx);

          if (isCompleted || rates.length > 0) {
            break;
          }
        }
      }

      // Filter only successful rates
      const successRates = rates.filter((r: any) => r.success === true);

      if (successRates.length === 0) {
        Logger.warn('No successful Skydropx rates', loggerCtx);
        return {
          price: args.fallbackRate,
          priceIncludesTax: false,
          taxRate: args.taxRate,
          metadata: { error: 'No rates available', service: 'Envío estándar' },
        };
      }

      // Filter by preferred carrier if set
      let filteredRates = successRates;
      if (args.preferredCarrier) {
        const carrier = args.preferredCarrier.toLowerCase();
        const carrierFiltered = successRates.filter(
          (r: any) => r.provider_name?.toLowerCase() === carrier
        );
        if (carrierFiltered.length > 0) {
          filteredRates = carrierFiltered;
        }
      }

      // Find cheapest rate
      const cheapest = filteredRates.reduce((min: any, r: any) => {
        const price = parseFloat(r.total || r.amount || '999999');
        const minPrice = parseFloat(min.total || min.amount || '999999');
        return price < minPrice ? r : min;
      }, filteredRates[0]);

      const totalPrice = parseFloat(cheapest.total || cheapest.amount || '0');
      const priceInCents = Math.round(totalPrice * 100);
      const provider = cheapest.provider_display_name || cheapest.provider_name || 'Skydropx';
      const serviceName = cheapest.provider_service_name || provider;
      const days = cheapest.days || 0;

      Logger.info(
        `Skydropx rate: ${provider} ${serviceName} = $${totalPrice} MXN (${days} days)`,
        loggerCtx
      );

      return {
        price: priceInCents,
        priceIncludesTax: false,
        taxRate: args.taxRate,
        metadata: {
          service: `${provider} — ${serviceName}`,
          estimatedDelivery: days > 0 ? `${days} día${days > 1 ? 's' : ''} hábiles` : '',
          totalWeight: `${totalWeightKg} kg`,
        },
      };
    } catch (err: any) {
      const errMsg = err.response?.data?.error || err.response?.data?.message || JSON.stringify(err.response?.data?.errors || {}) || err.message;
      Logger.error(`Skydropx API error: ${errMsg}`, loggerCtx);

      return {
        price: args.fallbackRate,
        priceIncludesTax: false,
        taxRate: args.taxRate,
        metadata: {
          error: 'Skydropx API unavailable, using fallback',
          service: 'Envío estándar (estimado)',
        },
      };
    }
  },
});