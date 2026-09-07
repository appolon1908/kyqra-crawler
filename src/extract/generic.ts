import { load } from 'cheerio';

export interface ExtractionData extends Record<string, unknown> {
  business_name: string;
  website: string;
  description: string;
  phone: string[];
  email: string[];
  address: string;
  page_title: string;
  schema_org: unknown[];
  source_url: string;
  crawl_timestamp: string;
}

export const extractGenericData = (html: string, rawUrl: string): ExtractionData => {
  const $ = load(html);
  const text = $('body').text().replace(/\s+/g, ' ').trim();
  const emails = [...new Set(text.match(/[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/gi) ?? [])].map(
    (email) => email.toLowerCase(),
  );
  const phones = [...new Set(text.match(/(?:\+?\d[\d .()\/-]{7,}\d)/g) ?? [])].map((phone) =>
    phone.replace(/[^\d+]/g, ''),
  );
  const structuredData: unknown[] = [];
  $('script[type="application/ld+json"]').each((_index, element) => {
    try {
      structuredData.push(JSON.parse($(element).text()) as unknown);
    } catch {
      // Ignore invalid JSON-LD while preserving the existing generic extractor behavior.
    }
  });
  const title = $('title').text().trim();

  return {
    business_name:
      $('meta[property="og:site_name"]').attr('content') || $('h1').first().text().trim() || title,
    website: new URL(rawUrl).origin,
    description: $('meta[name="description"]').attr('content') || '',
    phone: phones,
    email: emails,
    address: $('[itemprop="address"],address').first().text().replace(/\s+/g, ' ').trim(),
    page_title: title,
    schema_org: structuredData,
    source_url: rawUrl,
    crawl_timestamp: new Date().toISOString(),
  };
};
