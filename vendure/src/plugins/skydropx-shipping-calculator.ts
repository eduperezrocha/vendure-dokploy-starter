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
    'https://api.skydropx.com/api/v1/oauth/token',
    new URLSearchParams({
      grant_type: 'client_credentials',
      client_id: clientId,
      client_secret: clientSecret,
    }),
    { headers: { 'Content-Type': 'application/x-www-form-urlencoded' } }
  );

  skydropxToken = res.data.access_token;
  // Token valid for 2 hours, refresh 5 min early
  const expiresIn = res.data.expires_in || 7200;
  tokenExpiry = now + (expiresIn - 300) * 1000;
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
    preferredCarrier: {
      type: 'string',
      defaultValue: '',
      label: [{ languageCode: LanguageCode.en, value: 'Preferred Carrier (optional)' }],
      description: [{ languageCode: LanguageCode.en, value: 'e.g. Fedex, DHL, Estafeta, UPS — leave empty for cheapest across all' }],
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

    // Calculate total weight (default 1.5kg per item if not set)
    let totalWeightKg = 0;
    for (const line of order.lines) {
      const itemWeightGrams = (line.productVariant as any)?.customFields?.weight || 1500;
      totalWeightKg += (itemWeightGrams / 1000) * line.quantity;
    }
    totalWeightKg = Math.max(totalWeightKg, 0.5);

    try {
      // 1. Get OAuth token
      const token = await getToken(args.clientId, args.clientSecret);

      // 2. Create quotation
      const createRes = await axios.post(
        'https://api.skydropx.com/api/v1/quotations',
        {
          address_from: {
            country_code: 'MX',
            postal_code: args.originPostalCode,
          },
          address_to: {
            country_code: 'MX',
            postal_code: shippingAddress.postalCode,
          },
          packages: [
            {
              weight: Math.round(totalWeightKg * 10) / 10,
              length: 30,
              width: 20,
              height: 12,
            },
          ],
        },
        {
          headers: {
            'Authorization': `Bearer ${token}`,
            'Content-Type': 'application/json',
          },
        }
      );

      const quotationId = createRes.data?.data?.id;

      if (!quotationId) {
        throw new Error('No quotation ID returned');
      }

      // 3. Poll for rates (Skydropx calculates rates async)
      let rates: any[] = [];
      let attempts = 0;
      const maxAttempts = 5;

      while (attempts < maxAttempts) {
        await new Promise((r) => setTimeout(r, 2000)); // wait 2 seconds
        attempts++;

        const getRes = await axios.get(
          `https://api.skydropx.com/api/v1/quotations/${quotationId}`,
          {
            headers: {
              'Authorization': `Bearer ${token}`,
              'Content-Type': 'application/json',
            },
          }
        );

        const quotation = getRes.data?.data;
        const isCompleted = quotation?.attributes?.is_completed;

        // Collect rates from included
        const included = getRes.data?.included || [];
        rates = included
          .filter((item: any) => item.type === 'rates' && item.attributes?.success !== false)
          .map((item: any) => item.attributes);

        if (isCompleted || rates.length > 0) {
          break;
        }
      }

      if (rates.length === 0) {
        Logger.warn('No Skydropx rates returned', loggerCtx);
        return {
          price: args.fallbackRate,
          priceIncludesTax: false,
          taxRate: args.taxRate,
          metadata: { error: 'No rates available', service: 'Envío estándar' },
        };
      }

      // Filter by preferred carrier if set
      if (args.preferredCarrier) {
        const filtered = rates.filter(
          (r: any) => r.provider?.toLowerCase() === args.preferredCarrier.toLowerCase()
        );
        if (filtered.length > 0) {
          rates = filtered;
        }
      }

      // Find cheapest rate
      const cheapest = rates.reduce((min: any, r: any) => {
        const price = parseFloat(r.total_pricing || r.amount_local || '999999');
        const minPrice = parseFloat(min.total_pricing || min.amount_local || '999999');
        return price < minPrice ? r : min;
      }, rates[0]);

      const totalPrice = parseFloat(cheapest.total_pricing || cheapest.amount_local || '0');
      const priceInCents = Math.round(totalPrice * 100);
      const provider = cheapest.provider || 'Skydropx';
      const serviceName = cheapest.service_level_name || provider;
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
      const errMsg = err.response?.data?.error || err.response?.data?.message || err.message;
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