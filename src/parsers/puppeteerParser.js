import puppeteer from 'puppeteer-extra';
import StealthPlugin from 'puppeteer-extra-plugin-stealth';
import fs from 'fs';

puppeteer.use(StealthPlugin());

const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));

// === Получаем аргументы из командной строки ===
const [, , productUrl, targetRegionRaw] = process.argv;

if (!productUrl || !targetRegionRaw) {
  console.error('Usage: node puppeteer.js <PRODUCT_URL> <REGION>');
  process.exit(1);
}

const targetRegion = targetRegionRaw.trim();

// === Проверка на Cloudflare / anti-bot ===
async function waitForCloudflare(page, timeoutSec = 20) {
  const checkPattern = /выполняется\s+проверка|checking\s+your\s+browser|Подождите|Please\s+stand\s+by/i;
  let html = await page.content().catch(() => '');

  if (!checkPattern.test(html)) return true;

  console.warn('⚠️  Detected anti-bot check page. Waiting...');

  const start = Date.now();
  while ((Date.now() - start) < timeoutSec * 1000) {
    await sleep(1000);
    html = await page.content().catch(() => '');
    if (!checkPattern.test(html)) {
      console.log('✅ Anti-bot check passed\n');
      return true;
    }
  }

  console.error(`❌ Anti-bot check timeout after ${timeoutSec}s`);
  fs.writeFileSync('cloudflare-page.html', html);
  return false;
}

// === Выбор региона через модальное окно (устойчивая версия с fallback) ===
async function selectRegion(page, targetRegion) {
  console.log(`🔄 Attempting to select region: "${targetRegion}"`);

  const normalize = s => (s || '').replace(/\s+/g, ' ').trim().toLowerCase();
  const normalizedTarget = normalize(targetRegion);

  try {
    await page.waitForSelector('button[class*="Region_region"], button[data-testid*="region"]', { timeout: 10000 });
    const currentRegion = await page.$eval(
      'button[class*="Region_region"], button[data-testid*="region"]',
      el => el.textContent.trim()
    ).catch(() => null);

    console.log(`📍 Current region: "${currentRegion || 'unknown'}"`);

    if (currentRegion && normalize(currentRegion) === normalizedTarget) {
      console.log(`✅ Region already correct!\n`);
      return true;
    }

    console.log('🖱️ Clicking region button...');
    await page.click('button[class*="Region_region"], button[data-testid*="region"]');

    const modalSelectors = [
      'div[role="dialog"]',
      'div[class*="UiRegionListBase_listWrapper"]',
      'div[class*="RegionModal"]',
      'div[class*="RegionSelect"]'
    ];

    let modalAppeared = false;
    for (const selector of modalSelectors) {
      try {
        await page.waitForSelector(selector, { visible: true, timeout: 5000 });
        modalAppeared = true;
        console.log(`✅ Modal appeared via selector: ${selector}`);
        break;
      } catch {}
    }

    if (!modalAppeared) {
      console.warn('⚠️ Region modal did not appear. Skipping selection and continuing...');
      return false; // fallback
    }

    const clicked = await page.evaluate((target) => {
      const normalize = s => (s || '').replace(/\s+/g, ' ').trim().toLowerCase();
      const normalizedTarget = normalize(target);

      const allButtons = Array.from(document.querySelectorAll('button, li button, [role="option"]'));
      for (const button of allButtons) {
        const text = button.textContent.trim();
        const normalizedText = normalize(text);
        if (normalizedText === normalizedTarget || normalizedText.includes(normalizedTarget)) {
          button.click();
          return text;
        }
      }
      return null;
    }, targetRegion);

    if (!clicked) {
      console.warn(`⚠️ Region "${targetRegion}" not found in modal. Continuing without changing region...`);
      return false; // fallback
    }

    console.log(`✅ Clicked region: "${clicked}"`);
    await sleep(4000);

    const newRegion = await page.$eval(
      'button[class*="Region_region"], button[data-testid*="region"]',
      el => el.textContent.trim()
    ).catch(() => null);

    if (newRegion && normalize(newRegion) === normalizedTarget) {
      console.log(`✅ Region verified: "${newRegion}"\n`);
      return true;
    } else {
      console.warn(`⚠️ Region verification failed, still "${newRegion}". Continuing parsing...`);
      return false; // fallback
    }

  } catch (error) {
    console.warn(`⚠️ Region selection failed: ${error.message}. Continuing parsing...`);
    return false; // fallback
  }
}

// === Извлечение данных о товаре ===
async function extractProductData(page) {
  console.log('📊 Extracting product data...\n');

  const productData = await page.evaluate(() => {
    const result = {
      price: null,
      priceOld: null,
      rating: null,
      reviewCount: null,
      debug: {}
    };

    const extractNumber = (text) => {
      if (!text) return null;
      const cleaned = text.replace(/\s+/g, '').replace(',', '.').replace('₽','');
      const match = cleaned.match(/[\d]+\.?[\d]*/);
      return match ? parseFloat(match[0]) : null;
    };

    const container = document.querySelector(
      '[class*="ProductPage"], [class*="ProductCard"], main, [class*="product-info"], article'
    ) || document;

    const priceSelectors = [
      '.Price_price__3rj7L',
      '[class*="Price_price"]:not([class*="old"])',
      '[data-testid="product-price"]',
      'span[class*="price"]:not([class*="old"])'
    ];

    // === Основная цена ===
    for (const selector of priceSelectors) {
      const el = container.querySelector(selector);
      if (el && el.textContent.includes('₽')) {
        const price = extractNumber(el.textContent);
        if (price && price > 0 && price < 1000000) {
          result.price = price;
          result.debug.priceSelector = selector;
          break;
        }
      }
    }

    // === Старая цена рядом с основной ===
    if (result.price) {
      let priceElement = null;
      for (const selector of priceSelectors) {
        priceElement = container.querySelector(selector);
        if (priceElement) break;
      }

      if (priceElement) {
        const parent = priceElement.parentNode;
        const siblings = Array.from(parent.querySelectorAll('span, div, s, del'));

        for (const el of siblings) {
          if (!el.textContent.includes('₽')) continue;
          const num = extractNumber(el.textContent);
          if (num && num > result.price) {
            result.priceOld = num;
            result.debug.priceOldSelector = el.tagName + ' (sibling of price)';
            break;
          }
        }
      }
    }

    // === Рейтинг и количество отзывов через schema.org ===
    const ratingMeta = document.querySelector('section[itemprop="aggregateRating"] meta[itemprop="ratingValue"]');
    const reviewCountMeta = document.querySelector('section[itemprop="aggregateRating"] meta[itemprop="reviewCount"]');

    if (ratingMeta) {
      const rating = parseFloat(ratingMeta.getAttribute('content'));
      if (!isNaN(rating)) result.rating = rating;
    }

    if (reviewCountMeta) {
      const count = parseInt(reviewCountMeta.getAttribute('content'), 10);
      if (!isNaN(count)) result.reviewCount = count;
    }

    return result;
  });

  console.log('─────────────────────────────');
  console.log('📊 Extraction results:');
  console.log('─────────────────────────────');
  if (productData.price !== null) console.log(`✅ Price: ${productData.price} ₽  Selector: ${productData.debug.priceSelector}`);
  else console.log(`❌ Price: NOT FOUND`);
  if (productData.priceOld !== null) console.log(`✅ Old price: ${productData.priceOld} ₽  Selector: ${productData.debug.priceOldSelector}`);
  else console.log(`⚪ Old price: not found`);
  if (productData.rating !== null) console.log(`✅ Rating: ${productData.rating} / 5.0`);
  else console.log(`❌ Rating: NOT FOUND`);
  if (productData.reviewCount !== null) console.log(`✅ Review count: ${productData.reviewCount}`);
  else console.log(`❌ Review count: NOT FOUND`);
  console.log('─────────────────────────────\n');

  return productData;
}

// === ГЛАВНАЯ ФУНКЦИЯ ===
(async () => {
  console.log('🚀 Starting parser...');
  console.log(`📦 Product URL: ${productUrl}`);
  console.log(`🌍 Target region: ${targetRegion}\n`);

  const browser = await puppeteer.launch({
    headless: false,
    args: ['--no-sandbox','--disable-setuid-sandbox','--start-maximized','--disable-blink-features=AutomationControlled'],
    defaultViewport: null
  });

  const page = await browser.newPage();
  await page.setUserAgent('Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36');
  page.setDefaultTimeout(30000);

  page.on('console', msg => {
    const text = msg.text();
    if (text.includes('Found') || text.includes('Looking')) console.log(`   [Browser] ${text}`);
  });

  try {
    console.log('🌐 Loading product page...');
    await page.goto(productUrl, { waitUntil: 'domcontentloaded' });
    console.log('✓ Page loaded\n');

    const cfPassed = await waitForCloudflare(page, 25);
    if (!cfPassed) throw new Error('Anti-bot check failed');

    await sleep(2000);
    await selectRegion(page, targetRegion);
    await sleep(3000);

    try { await page.waitForSelector('.Price_price__3rj7L, [class*="Price_price"]', { timeout: 10000, visible: true }); } catch {}

    const productData = await extractProductData(page);

    // === Сохраняем данные ===
    const outputLines = [];
    if (productData.price !== null) outputLines.push(`price=${productData.price}`);
    if (productData.priceOld !== null) outputLines.push(`priceOld=${productData.priceOld}`);
    if (productData.rating !== null) outputLines.push(`rating=${productData.rating}`);
    if (productData.reviewCount !== null) outputLines.push(`reviewCount=${productData.reviewCount}`);

    if (outputLines.length > 0) {
      const content = outputLines.join('\n');
      fs.writeFileSync('product.txt', content);
      console.log('💾 Saved to product.txt\n');
      console.log('📄 File content:');
      console.log('═══════════════════════');
      console.log(content);
      console.log('═══════════════════════\n');
    } else {
      console.warn('⚠️  No data extracted!');
      const html = await page.content();
      fs.writeFileSync('debug.html', html);
      console.log('🔍 Saved debug.html for inspection\n');
    }

    console.log('📸 Taking screenshot...');
    await page.screenshot({ path: 'screenshot.jpg', fullPage: true, type: 'jpeg', quality: 90 });
    console.log('✅ Screenshot saved: screenshot.jpg\n');

  } catch (err) {
    console.error('\n❌ Parser failed:', err.message);
    const html = await page.content().catch(() => null);
    if (html) fs.writeFileSync('error-page.html', html);
    throw err;
  } finally {
    await browser.close();
    console.log('🔒 Browser closed\n');
  }
})()
.then(() => { console.log('✅ Parser completed successfully!'); process.exit(0); })
.catch((err) => { console.error('💥 Critical error:', err.message); process.exit(1); });
