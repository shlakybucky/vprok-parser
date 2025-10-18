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









// import puppeteer from 'puppeteer-extra';
// import StealthPlugin from 'puppeteer-extra-plugin-stealth';
// import fs from 'fs';

// puppeteer.use(StealthPlugin());

// const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));

// // === Получаем аргументы из командной строки ===
// const [, , productUrl, targetRegionRaw] = process.argv;

// if (!productUrl || !targetRegionRaw) {
//   console.error('Usage: node puppeteer.js <PRODUCT_URL> <REGION>');
//   console.error('Example: node puppeteer.js "https://www.vprok.ru/product/..." "Москва и область"');
//   process.exit(1);
// }

// const targetRegion = targetRegionRaw.trim();

// // === Проверка на Cloudflare / anti-bot ===
// async function waitForCloudflare(page, timeoutSec = 20) {
//   const checkPattern = /выполняется\s+проверка|checking\s+your\s+browser|Подождите|Please\s+stand\s+by/i;
//   let html = await page.content().catch(() => '');
  
//   if (!checkPattern.test(html)) return true;

//   console.warn('⚠️  Detected anti-bot check page. Waiting...');

//   const start = Date.now();
//   while ((Date.now() - start) < timeoutSec * 1000) {
//     await sleep(1000);
//     html = await page.content().catch(() => '');
//     if (!checkPattern.test(html)) {
//       console.log('✅ Anti-bot check passed\n');
//       return true;
//     }
//   }

//   console.error(`❌ Anti-bot check timeout after ${timeoutSec}s`);
//   fs.writeFileSync('cloudflare-page.html', html);
//   return false;
// }

// // === Выбор региона через модальное окно ===
// async function selectRegion(page, targetRegion) {
//   console.log(`🔄 Attempting to select region: "${targetRegion}"`);
  
//   const normalize = s => (s || '').replace(/\s+/g, ' ').trim().toLowerCase();
//   const normalizedTarget = normalize(targetRegion);

//   try {
//     const currentRegion = await page.$eval(
//       'button[class^="Region_region__"] .Region_text__Wm7FO',
//       el => el.textContent.trim()
//     ).catch(() => null);

//     console.log(`📍 Current region: "${currentRegion || 'unknown'}"`);

//     if (currentRegion && normalize(currentRegion) === normalizedTarget) {
//       console.log(`✅ Region already correct!\n`);
//       return true;
//     }

//     console.log('🖱️  Clicking region button...');
//     await page.click('button[class^="Region_region__"]');
//     await sleep(1500);

//     const modalVisible = await page.evaluate(() => {
//       const modal = document.querySelector('div[role="dialog"]');
//       return modal && modal.offsetParent !== null;
//     });

//     if (!modalVisible) {
//       console.error('❌ Modal did not appear');
//       return false;
//     }

//     console.log('✓ Modal opened');

//     const clicked = await page.evaluate((target) => {
//       const normalize = s => (s || '').replace(/\s+/g, ' ').trim().toLowerCase();
//       const buttons = document.querySelectorAll('div[class^="UiRegionListBase_listWrapper__"] ul li button');
//       const normalizedTarget = normalize(target);
//       for (const button of buttons) {
//         const text = button.textContent.trim();
//         const normalizedText = normalize(text);
//         if (normalizedText === normalizedTarget || normalizedText.includes(normalizedTarget)) {
//           button.click();
//           return text;
//         }
//       }
//       return null;
//     }, targetRegion);

//     if (!clicked) {
//       console.error(`❌ Region "${targetRegion}" not found in list`);
//       return false;
//     }

//     console.log(`✅ Clicked region: "${clicked}"`);
//     await sleep(3000);

//     const newRegion = await page.$eval(
//       'button[class^="Region_region__"] .Region_text__Wm7FO',
//       el => el.textContent.trim()
//     ).catch(() => null);

//     if (newRegion && normalize(newRegion) === normalizedTarget) {
//       console.log(`✅ Region verified: "${newRegion}"\n`);
//       return true;
//     } else {
//       console.warn(`⚠️  Region verification failed. Got: "${newRegion}"\n`);
//       return false;
//     }

//   } catch (error) {
//     console.error(`❌ Failed to select region: ${error.message}\n`);
//     return false;
//   }
// }

// // === ИЗВЛЕЧЕНИЕ ДАННЫХ О ТОВАРЕ ===
// async function extractProductData(page) {
//   console.log('📊 Extracting product data...\n');

//   const productData = await page.evaluate(() => {
//     const result = {
//       price: null,
//       priceOld: null,
//       rating: null,
//       reviewCount: null,
//       debug: {}
//     };

//     const extractNumber = (text) => {
//       if (!text) return null;
//       const cleaned = text.replace(/\s+/g, '').replace(',', '.');
//       const match = cleaned.match(/[\d]+\.?[\d]*/);
//       return match ? parseFloat(match[0]) : null;
//     };

//     const productContainer = document.querySelector(
//       '[class*="ProductPage"], [class*="ProductCard"], main, [class*="product-info"], article'
//     ) || document;

//     const searchContext = productContainer;

//     const priceSelectors = [
//       '.Price_price__3rj7L',
//       '[class*="Price_price"]:not([class*="old"])',
//       '[data-testid="product-price"]',
//       'span[class*="price"]:not([class*="old"])'
//     ];

//     for (const selector of priceSelectors) {
//       const el = searchContext.querySelector(selector);
//       if (el && el.textContent.includes('₽')) {
//         const price = extractNumber(el.textContent);
//         if (price && price > 0 && price < 1000000) {
//           result.price = price;
//           result.debug.priceSelector = selector;
//           console.log('Found price:', price, 'via', selector);
//           break;
//         }
//       }
//     }

//     if (result.price) {
//       let priceElement = null;
//       for (const selector of priceSelectors) {
//         priceElement = searchContext.querySelector(selector);
//         if (priceElement) break;
//       }
//       if (priceElement) {
//         const priceContainer = priceElement.closest('[class*="Price"], [class*="price"]');
//         if (priceContainer) {
//           const oldPriceSelectors = [
//             '.Price_oldPrice__1mNRO',
//             '[class*="Price_oldPrice"]',
//             '[class*="oldPrice"]',
//             's',
//             'del'
//           ];
//           for (const selector of oldPriceSelectors) {
//             const el = priceContainer.querySelector(selector);
//             if (el && el.textContent.includes('₽')) {
//               const oldPrice = extractNumber(el.textContent);
//               if (oldPrice && oldPrice > result.price) {
//                 result.priceOld = oldPrice;
//                 result.debug.priceOldSelector = selector + ' (in price container)';
//                 console.log('Found old price:', oldPrice, 'via', selector);
//                 break;
//               }
//             }
//           }
//           if (!result.priceOld) {
//             const allInContainer = priceContainer.querySelectorAll('span, div');
//             for (const el of allInContainer) {
//               const style = window.getComputedStyle(el);
//               if (style.textDecoration.includes('line-through') && el.textContent.includes('₽')) {
//                 const oldPrice = extractNumber(el.textContent);
//                 if (oldPrice && oldPrice > result.price) {
//                   result.priceOld = oldPrice;
//                   result.debug.priceOldSelector = 'line-through (in price container)';
//                   console.log('Found old price:', oldPrice, 'via line-through style');
//                   break;
//                 }
//               }
//             }
//           }
//         }
//       }
//     }

//     // === Рейтинг и количество отзывов через schema.org ===
//     const ratingMeta = document.querySelector('section[itemprop="aggregateRating"] meta[itemprop="ratingValue"]');
//     const reviewCountMeta = document.querySelector('section[itemprop="aggregateRating"] meta[itemprop="reviewCount"]');

//     if (ratingMeta) {
//       const rating = parseFloat(ratingMeta.getAttribute('content'));
//       if (!isNaN(rating)) {
//         result.rating = rating;
//         result.debug.ratingSelector = 'meta[itemprop="ratingValue"]';
//         console.log('Found rating via schema.org:', rating);
//       }
//     }

//     if (reviewCountMeta) {
//       const count = parseInt(reviewCountMeta.getAttribute('content'), 10);
//       if (!isNaN(count)) {
//         result.reviewCount = count;
//         result.debug.reviewSelector = 'meta[itemprop="reviewCount"]';
//         console.log('Found review count via schema.org:', count);
//       }
//     }

//     // === Резервный поиск рейтинга ===
//     if (result.rating === null) {
//       const ratingSelectors = ['.Rating_rating__1KFrt', '[class*="Rating_rating"]', '[class*="rating"]'];
//       for (const selector of ratingSelectors) {
//         const el = searchContext.querySelector(selector);
//         if (el) {
//           const match = el.textContent.trim().match(/([0-5](?:[.,]\d)?)/);
//           if (match) {
//             const rating = parseFloat(match[1].replace(',', '.'));
//             if (!isNaN(rating) && rating >= 0 && rating <= 5) {
//               result.rating = rating;
//               result.debug.ratingSelector = selector + ' (fallback)';
//               console.log('Found rating (fallback):', rating);
//               break;
//             }
//           }
//         }
//       }
//     }

//     // === Резервный поиск количества отзывов ===
//     if (result.reviewCount === null) {
//       const reviewLinks = searchContext.querySelectorAll('a[href*="review"], button');
//       for (const el of reviewLinks) {
//         const text = el.textContent.toLowerCase();
//         if (text.includes('отзыв') && text.match(/\d+/)) {
//           const numbers = text.match(/\d+/g);
//           if (numbers && numbers.length > 0) {
//             const count = parseInt(numbers[0]);
//             if (count > 0 && count < 100000) {
//               result.reviewCount = count;
//               result.debug.reviewSelector = 'link with "отзыв" (fallback)';
//               console.log('Found review count (fallback):', count);
//               break;
//             }
//           }
//         }
//       }
//     }

//     return result;
//   });

//   // === Логирование ===
//   console.log('─────────────────────────────');
//   console.log('📊 Extraction results:');
//   console.log('─────────────────────────────');
//   if (productData.price !== null) console.log(`✅ Price: ${productData.price} ₽  Selector: ${productData.debug.priceSelector}`);
//   else console.log(`❌ Price: NOT FOUND`);
//   if (productData.priceOld !== null) console.log(`✅ Old price: ${productData.priceOld} ₽  Selector: ${productData.debug.priceOldSelector}`);
//   else console.log(`⚪ Old price: not found`);
//   if (productData.rating !== null) console.log(`✅ Rating: ${productData.rating} / 5.0  Selector: ${productData.debug.ratingSelector}`);
//   else console.log(`❌ Rating: NOT FOUND`);
//   if (productData.reviewCount !== null) console.log(`✅ Review count: ${productData.reviewCount}  Selector: ${productData.debug.reviewSelector}`);
//   else console.log(`❌ Review count: NOT FOUND`);
//   console.log('─────────────────────────────\n');

//   return productData;
// }

// // === ГЛАВНАЯ ФУНКЦИЯ ===
// (async () => {
//   console.log('🚀 Starting parser...');
//   console.log(`📦 Product URL: ${productUrl}`);
//   console.log(`🌍 Target region: ${targetRegion}\n`);

//   const browser = await puppeteer.launch({
//     headless: false,
//     args: ['--no-sandbox','--disable-setuid-sandbox','--start-maximized','--disable-blink-features=AutomationControlled'],
//     defaultViewport: null
//   });

//   const page = await browser.newPage();
//   await page.setUserAgent('Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36');
//   page.setDefaultTimeout(30000);

//   page.on('console', msg => {
//     const text = msg.text();
//     if (text.includes('Found') || text.includes('Looking')) console.log(`   [Browser] ${text}`);
//   });

//   try {
//     console.log('🌐 Loading product page...');
//     await page.goto(productUrl, { waitUntil: 'domcontentloaded' });
//     console.log('✓ Page loaded\n');

//     const cfPassed = await waitForCloudflare(page, 25);
//     if (!cfPassed) throw new Error('Anti-bot check failed');

//     await sleep(2000);

//     await selectRegion(page, targetRegion);
//     await sleep(3000);

//     try { await page.waitForSelector('.Price_price__3rj7L, [class*="Price_price"]', { timeout: 10000, visible: true }); } catch {}
    
//     const productData = await extractProductData(page);

//     // === Сохраняем данные ===
//     const outputLines = [];
//     if (productData.price !== null) outputLines.push(`price=${productData.price}`);
//     if (productData.priceOld !== null) outputLines.push(`priceOld=${productData.priceOld}`);
//     if (productData.rating !== null) outputLines.push(`rating=${productData.rating}`);
//     if (productData.reviewCount !== null) outputLines.push(`reviewCount=${productData.reviewCount}`);

//     if (outputLines.length > 0) {
//       const content = outputLines.join('\n');
//       fs.writeFileSync('product.txt', content);
//       console.log('💾 Saved to product.txt\n');
//       console.log('📄 File content:');
//       console.log('═══════════════════════');
//       console.log(content);
//       console.log('═══════════════════════\n');
//     } else {
//       console.warn('⚠️  No data extracted!');
//       const html = await page.content();
//       fs.writeFileSync('debug.html', html);
//       console.log('🔍 Saved debug.html for inspection\n');
//     }

//     // === Скриншот ===
//     console.log('📸 Taking screenshot...');
//     await page.screenshot({ path: 'screenshot.jpg', fullPage: true, type: 'jpeg', quality: 90 });
//     console.log('✅ Screenshot saved: screenshot.jpg\n');

//   } catch (err) {
//     console.error('\n❌ Parser failed:', err.message);
//     const html = await page.content().catch(() => null);
//     if (html) fs.writeFileSync('error-page.html', html);
//     throw err;
//   } finally {
//     await browser.close();
//     console.log('🔒 Browser closed\n');
//   }
// })()
// .then(() => { console.log('✅ Parser completed successfully!'); process.exit(0); })
// .catch((err) => { console.error('💥 Critical error:', err.message); process.exit(1); });









// import puppeteer from 'puppeteer-extra';
// import StealthPlugin from 'puppeteer-extra-plugin-stealth';
// import fs from 'fs';

// puppeteer.use(StealthPlugin());

// const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));

// // === Получаем аргументы из командной строки ===
// const [, , productUrl, targetRegionRaw] = process.argv;

// if (!productUrl || !targetRegionRaw) {
//   console.error('Usage: node puppeteer.js <PRODUCT_URL> <REGION>');
//   console.error('Example: node puppeteer.js "https://www.vprok.ru/product/..." "Москва и область"');
//   process.exit(1);
// }

// const targetRegion = targetRegionRaw.trim();

// // === Проверка на Cloudflare / anti-bot ===
// async function waitForCloudflare(page, timeoutSec = 20) {
//   const checkPattern = /выполняется\s+проверка|checking\s+your\s+browser|Подождите|Please\s+stand\s+by/i;
//   let html = await page.content().catch(() => '');
  
//   if (!checkPattern.test(html)) return true;

//   console.warn('⚠️  Detected anti-bot check page. Waiting...');

//   const start = Date.now();
//   while ((Date.now() - start) < timeoutSec * 1000) {
//     await sleep(1000);
//     html = await page.content().catch(() => '');
//     if (!checkPattern.test(html)) {
//       console.log('✅ Anti-bot check passed\n');
//       return true;
//     }
//   }

//   console.error(`❌ Anti-bot check timeout after ${timeoutSec}s`);
//   fs.writeFileSync('cloudflare-page.html', html);
//   return false;
// }

// // === Выбор региона через модальное окно ===
// async function selectRegion(page, targetRegion) {
//   console.log(`🔄 Attempting to select region: "${targetRegion}"`);
  
//   const normalize = s => (s || '').replace(/\s+/g, ' ').trim().toLowerCase();
//   const normalizedTarget = normalize(targetRegion);

//   try {
//     // 1. Проверяем текущий регион
//     const currentRegion = await page.$eval(
//       'button[class^="Region_region__"] .Region_text__Wm7FO',
//       el => el.textContent.trim()
//     ).catch(() => null);

//     console.log(`📍 Current region: "${currentRegion || 'unknown'}"`);

//     if (currentRegion && normalize(currentRegion) === normalizedTarget) {
//       console.log(`✅ Region already correct!\n`);
//       return true;
//     }

//     // 2. Кликаем на кнопку региона
//     console.log('🖱️  Clicking region button...');
//     await page.click('button[class^="Region_region__"]');
    
//     // 3. Ждем появления модального окна с увеличенным таймаутом
//     console.log('⏳ Waiting for modal...');
//     await sleep(1500);

//     // Проверяем, что модальное окно действительно появилось
//     const modalVisible = await page.evaluate(() => {
//       const modal = document.querySelector('div[role="dialog"]');
//       return modal && modal.offsetParent !== null;
//     });

//     if (!modalVisible) {
//       console.error('❌ Modal did not appear');
//       return false;
//     }

//     console.log('✓ Modal opened');

//     // 4. Получаем список всех регионов
//     const regions = await page.$$eval(
//       'div[class^="UiRegionListBase_listWrapper__"] ul li button',
//       buttons => buttons.map(btn => btn.textContent.trim())
//     );

//     console.log(`✓ Found ${regions.length} regions:`, regions);

//     // 5. Ищем и кликаем нужный регион
//     const clicked = await page.evaluate((target) => {
//       // Нормализация внутри evaluate
//       const normalize = s => (s || '').replace(/\s+/g, ' ').trim().toLowerCase();
      
//       const buttons = document.querySelectorAll('div[class^="UiRegionListBase_listWrapper__"] ul li button');
//       const normalizedTarget = normalize(target);
      
//       for (const button of buttons) {
//         const text = button.textContent.trim();
//         const normalizedText = normalize(text);
        
//         console.log('Comparing:', normalizedText, '===', normalizedTarget);
        
//         if (normalizedText === normalizedTarget || normalizedText.includes(normalizedTarget)) {
//           console.log('MATCH! Clicking:', text);
//           button.click();
//           return text;
//         }
//       }
//       return null;
//     }, targetRegion);

//     if (!clicked) {
//       console.error(`❌ Region "${targetRegion}" not found in list`);
//       return false;
//     }

//     console.log(`✅ Clicked region: "${clicked}"`);

//     // 6. Ждем закрытия модального окна и перезагрузки данных
//     await sleep(3000);

//     // 7. Проверяем, что регион изменился
//     const newRegion = await page.$eval(
//       'button[class^="Region_region__"] .Region_text__Wm7FO',
//       el => el.textContent.trim()
//     ).catch(() => null);

//     if (newRegion && normalize(newRegion) === normalizedTarget) {
//       console.log(`✅ Region verified: "${newRegion}"\n`);
//       return true;
//     } else {
//       console.warn(`⚠️  Region verification failed. Got: "${newRegion}"\n`);
//       return false;
//     }

//   } catch (error) {
//     console.error(`❌ Failed to select region: ${error.message}\n`);
//     return false;
//   }
// }

// // === Извлечение данных о товаре ===
// async function extractProductData(page) {
//   console.log('📊 Extracting product data...\n');

//   const productData = await page.evaluate(() => {
//     const result = {
//       price: null,
//       priceOld: null,
//       rating: null,
//       reviewCount: null,
//       debug: {}
//     };

//     const extractNumber = (text) => {
//       if (!text) return null;
//       const cleaned = text.replace(/\s+/g, '').replace(',', '.');
//       const match = cleaned.match(/[\d]+\.?[\d]*/);
//       return match ? parseFloat(match[0]) : null;
//     };

//     // === НАХОДИМ КОНТЕЙНЕР ОСНОВНОГО ТОВАРА ===
//     console.log('Looking for product container...');
    
//     // Ищем основной контейнер товара (не рекомендации)
//     const productContainer = document.querySelector(
//       '[class*="ProductPage"], [class*="ProductCard"], main, [class*="product-info"]'
//     );
    
//     if (!productContainer) {
//       console.warn('Product container not found, searching in full document');
//     } else {
//       console.log('Product container found:', productContainer.className);
//     }
    
//     // Контекст поиска - либо контейнер товара, либо весь документ
//     const searchContext = productContainer || document;

//     // === ЦЕНА ===
//     console.log('Looking for price...');
//     const priceSelectors = [
//       '.Price_price__3rj7L',
//       '[class*="Price_price"]:not([class*="old"])',
//       '[data-testid="product-price"]',
//       'span[class*="price"]:not([class*="old"])'
//     ];

//     for (const selector of priceSelectors) {
//       const el = searchContext.querySelector(selector);
//       if (el && el.textContent.includes('₽')) {
//         const price = extractNumber(el.textContent);
//         if (price && price > 0 && price < 1000000) {
//           result.price = price;
//           result.debug.priceSelector = selector;
//           console.log('Found price:', price, 'via', selector);
//           break;
//         }
//       }
//     }

//     // === СТАРАЯ ЦЕНА ===
//     console.log('Looking for old price...');
    
//     // ВАЖНО: Ищем ТОЛЬКО в непосредственной близости от текущей цены
//     if (result.price) {
//       // Находим элемент с текущей ценой
//       let priceElement = null;
//       for (const selector of priceSelectors) {
//         priceElement = searchContext.querySelector(selector);
//         if (priceElement) break;
//       }
      
//       if (priceElement) {
//         // Ищем старую цену в родительском контейнере
//         const priceContainer = priceElement.closest('[class*="Price"], [class*="price"]');
        
//         if (priceContainer) {
//           console.log('Searching old price in price container only');
          
//           // Ищем зачеркнутую цену ТОЛЬКО в этом контейнере
//           const oldPriceSelectors = [
//             '.Price_oldPrice__1mNRO',
//             '[class*="Price_oldPrice"]',
//             '[class*="oldPrice"]',
//             's',
//             'del'
//           ];
          
//           for (const selector of oldPriceSelectors) {
//             const el = priceContainer.querySelector(selector);
//             if (el && el.textContent.includes('₽')) {
//               const oldPrice = extractNumber(el.textContent);
//               if (oldPrice && oldPrice > result.price) {
//                 result.priceOld = oldPrice;
//                 result.debug.priceOldSelector = selector + ' (in price container)';
//                 console.log('Found old price:', oldPrice, 'via', selector);
//                 break;
//               }
//             }
//           }
          
//           // Если не нашли, ищем по стилю line-through
//           if (!result.priceOld) {
//             const allInContainer = priceContainer.querySelectorAll('span, div');
//             for (const el of allInContainer) {
//               const style = window.getComputedStyle(el);
//               if (style.textDecoration.includes('line-through') && el.textContent.includes('₽')) {
//                 const oldPrice = extractNumber(el.textContent);
//                 if (oldPrice && oldPrice > result.price) {
//                   result.priceOld = oldPrice;
//                   result.debug.priceOldSelector = 'line-through (in price container)';
//                   console.log('Found old price:', oldPrice, 'via line-through style');
//                   break;
//                 }
//               }
//             }
//           }
//         }
//       }
//     }
    
//     if (!result.priceOld) {
//       console.log('Old price not found (product may not have discount)');
//     }

//     // === РЕЙТИНГ ===
//     console.log('Looking for rating...');
    
//     // Способ 1: Ищем по классам
//     const ratingSelectors = [
//       '.Rating_rating__1KFrt',
//       '[class*="Rating_rating"]',
//       '[class*="rating"]',
//       '[data-testid="product-rating"]',
//       '[itemprop="ratingValue"]'
//     ];

//     for (const selector of ratingSelectors) {
//       const el = document.querySelector(selector);
//       if (el) {
//         const text = el.textContent.trim();
//         // Ищем паттерн вида "4.8" или "4,8"
//         const match = text.match(/([0-5])[.,](\d)/);
//         if (match) {
//           const rating = parseFloat(match[0].replace(',', '.'));
//           if (rating >= 0 && rating <= 5) {
//             result.rating = rating;
//             result.debug.ratingSelector = selector;
//             console.log('Found rating:', rating, 'via', selector);
//             break;
//           }
//         }
//       }
//     }

//     // Способ 2: Ищем контейнер с рейтингом и отзывами
//     if (result.rating === null) {
//       const reviewContainers = document.querySelectorAll('[class*="Review"], [class*="rating"]');
//       for (const container of reviewContainers) {
//         const text = container.textContent;
//         // Ищем паттерн: число от 0 до 5 с точкой
//         const match = text.match(/([0-5])[.,](\d)/);
//         if (match) {
//           const rating = parseFloat(match[0].replace(',', '.'));
//           if (rating >= 0 && rating <= 5) {
//             result.rating = rating;
//             result.debug.ratingSelector = 'review container';
//             console.log('Found rating:', rating, 'in review container');
//             break;
//           }
//         }
//       }
//     }

//     // Способ 3: Ищем SVG со звездами и число рядом
//     if (result.rating === null) {
//       const svgStars = document.querySelectorAll('svg');
//       for (const svg of svgStars) {
//         // Проверяем что это звезды
//         const parent = svg.closest('div, span');
//         if (parent) {
//           const text = parent.textContent;
//           const match = text.match(/([0-5])[.,](\d)/);
//           if (match) {
//             const rating = parseFloat(match[0].replace(',', '.'));
//             if (rating >= 0 && rating <= 5) {
//               result.rating = rating;
//               result.debug.ratingSelector = 'near stars';
//               console.log('Found rating:', rating, 'near stars');
//               break;
//             }
//           }
//         }
//       }
//     }

//     // === КОЛИЧЕСТВО ОТЗЫВОВ ===
//     console.log('Looking for review count...');
    
//     // Сначала ищем по конкретным селекторам В КОНТЕЙНЕРЕ ТОВАРА
//     const reviewSelectors = [
//       '.Review_count__2nFJx',
//       '[class*="Review_count"]',
//       '[data-testid="product-review-count"]',
//       '[itemprop="reviewCount"]'
//     ];

//     for (const selector of reviewSelectors) {
//       const el = searchContext.querySelector(selector);
//       if (el) {
//         const text = el.textContent.trim();
//         const count = extractNumber(text);
        
//         // ВАЖНО: количество отзывов - целое число, обычно > 0
//         if (count !== null && Number.isInteger(count) && count >= 0 && count < 100000) {
//           result.reviewCount = Math.floor(count);
//           result.debug.reviewSelector = selector;
//           console.log('Found review count:', count, 'via', selector);
//           break;
//         }
//       }
//     }

//     // Альтернативный поиск - ищем ссылку с текстом "отзыв" В КОНТЕЙНЕРЕ ТОВАРА
//     if (result.reviewCount === null) {
//       const reviewLinks = searchContext.querySelectorAll('a[href*="review"], button');
//       for (const el of reviewLinks) {
//         const text = el.textContent.toLowerCase();
        
//         // Проверяем что есть слово "отзыв" И число
//         if (text.includes('отзыв') && text.match(/\d+/)) {
//           const numbers = text.match(/\d+/g);
          
//           if (numbers && numbers.length > 0) {
//             // Берем первое число
//             const count = parseInt(numbers[0]);
            
//             // Проверяем что это не рейтинг (не от 0 до 5) и не ID товара (не слишком большое)
//             if (count > 5 && count < 100000) {
//               result.reviewCount = count;
//               result.debug.reviewSelector = 'link with "отзыв" (in product container)';
//               console.log('Found review count:', count, 'via text search');
//               break;
//             }
//           }
//         }
//       }
//     }
    
//     if (!result.reviewCount) {
//       console.log('Review count not found');
//     }

//     return result;
//   });

//   // Выводим результаты
//   console.log('─────────────────────────────');
//   console.log('📊 Extraction results:');
//   console.log('─────────────────────────────');
  
//   if (productData.price !== null) {
//     console.log(`✅ Price: ${productData.price} ₽`);
//     console.log(`   Selector: ${productData.debug.priceSelector}`);
//   } else {
//     console.log(`❌ Price: NOT FOUND`);
//   }

//   if (productData.priceOld !== null) {
//     console.log(`✅ Old price: ${productData.priceOld} ₽`);
//     console.log(`   Selector: ${productData.debug.priceOldSelector}`);
//   } else {
//     console.log(`⚪ Old price: not found (no discount)`);
//   }

//   if (productData.rating !== null) {
//     console.log(`✅ Rating: ${productData.rating} / 5.0`);
//     console.log(`   Selector: ${productData.debug.ratingSelector}`);
//   } else {
//     console.log(`❌ Rating: NOT FOUND`);
//   }

//   if (productData.reviewCount !== null) {
//     console.log(`✅ Review count: ${productData.reviewCount}`);
//     console.log(`   Selector: ${productData.debug.reviewSelector}`);
//   } else {
//     console.log(`❌ Review count: NOT FOUND`);
//   }
  
//   console.log('─────────────────────────────\n');

//   return productData;
// }

// // === ГЛАВНАЯ ФУНКЦИЯ ===
// (async () => {
//   console.log('🚀 Starting parser...');
//   console.log(`📦 Product URL: ${productUrl}`);
//   console.log(`🌍 Target region: ${targetRegion}\n`);

//   const browser = await puppeteer.launch({
//     headless: false,
//     args: [
//       '--no-sandbox',
//       '--disable-setuid-sandbox',
//       '--start-maximized',
//       '--disable-blink-features=AutomationControlled'
//     ],
//     defaultViewport: null
//   });

//   const page = await browser.newPage();
//   await page.setUserAgent(
//     'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36'
//   );
//   page.setDefaultTimeout(30000);

//   // Включаем логи из браузера
//   page.on('console', msg => {
//     const text = msg.text();
//     if (text.includes('Looking for') || text.includes('Found')) {
//       console.log(`   [Browser] ${text}`);
//     }
//   });

//   try {
//     // 1. Открываем страницу товара
//     console.log('🌐 Loading product page...');
//     await page.goto(productUrl, { waitUntil: 'domcontentloaded' });
//     console.log('✓ Page loaded\n');

//     // 2. Проверяем Cloudflare
//     const cfPassed = await waitForCloudflare(page, 25);
//     if (!cfPassed) {
//       throw new Error('Anti-bot check failed');
//     }

//     // 3. Ждем загрузки основного контента
//     await sleep(2000);

//     // 4. Выбираем регион
//     const regionSuccess = await selectRegion(page, targetRegion);
//     if (!regionSuccess) {
//       console.warn('⚠️  Region selection failed, but continuing...\n');
//     }

//     // 5. Ждем загрузки данных после смены региона
//     console.log('⏳ Waiting for product data to load...');
//     await sleep(3000);

//     // Дополнительно ждем появления цены
//     try {
//       await page.waitForSelector('.Price_price__3rj7L, [class*="Price_price"]', { 
//         timeout: 10000,
//         visible: true 
//       });
//       console.log('✓ Price element visible\n');
//     } catch (e) {
//       console.warn('⚠️  Price element not found, continuing...\n');
//     }

//     // 6. Извлекаем данные о товаре
//     const productData = await extractProductData(page);

//     // Если рейтинг не найден, делаем дополнительную диагностику
//     if (!productData.rating) {
//       console.log('\n🔍 DEBUG: Rating not found, analyzing page structure...');
      
//       const debugInfo = await page.evaluate(() => {
//         const info = {
//           ratingClasses: [],
//           reviewElements: [],
//           numbersFound: []
//         };
        
//         // Собираем все элементы с "rating" в классе
//         const ratingElements = document.querySelectorAll('[class*="rating"], [class*="Rating"]');
//         ratingElements.forEach(el => {
//           info.ratingClasses.push({
//             tag: el.tagName,
//             class: el.className,
//             text: el.textContent.trim().substring(0, 50)
//           });
//         });
        
//         // Собираем все элементы с "review" в классе
//         const reviewElements = document.querySelectorAll('[class*="review"], [class*="Review"]');
//         reviewElements.forEach(el => {
//           info.reviewElements.push({
//             tag: el.tagName,
//             class: el.className,
//             text: el.textContent.trim().substring(0, 100)
//           });
//         });
        
//         // Ищем все числа от 0 до 5 с точкой
//         const allText = document.body.innerText;
//         const matches = allText.match(/[0-5]\.[0-9]/g);
//         if (matches) {
//           info.numbersFound = [...new Set(matches)];
//         }
        
//         return info;
//       });
      
//       console.log('Elements with "rating" class:', debugInfo.ratingClasses);
//       console.log('Elements with "review" class:', debugInfo.reviewElements);
//       console.log('Numbers 0-5 with decimal found on page:', debugInfo.numbersFound);
//       console.log('');
//     }

//     // 7. Сохраняем в файл product.txt
//     console.log('💾 Saving data to product.txt...');

//     const outputLines = [];
//     if (productData.price !== null) outputLines.push(`price=${productData.price}`);
//     if (productData.priceOld !== null) outputLines.push(`priceOld=${productData.priceOld}`);
//     if (productData.rating !== null) outputLines.push(`rating=${productData.rating}`);
//     if (productData.reviewCount !== null) outputLines.push(`reviewCount=${productData.reviewCount}`);

//     if (outputLines.length > 0) {
//       const content = outputLines.join('\n');
//       fs.writeFileSync('product.txt', content);
//       console.log('✅ Saved to product.txt\n');
//       console.log('📄 File content:');
//       console.log('═══════════════════════');
//       console.log(content);
//       console.log('═══════════════════════\n');
//     } else {
//       console.warn('⚠️  No data extracted!\n');
//       const html = await page.content();
//       fs.writeFileSync('debug.html', html);
//       console.log('🔍 Saved debug.html for inspection\n');
//     }

//     // 8. Делаем скриншот
//     console.log('📸 Taking screenshot...');
//     await page.screenshot({
//       path: 'screenshot.jpg',
//       fullPage: true,
//       type: 'jpeg',
//       quality: 90
//     });
//     console.log('✅ Screenshot saved: screenshot.jpg\n');

//   } catch (err) {
//     console.error('\n❌ Parser failed:', err.message);
//     console.error(err.stack);
    
//     try {
//       const html = await page.content().catch(() => null);
//       if (html) {
//         fs.writeFileSync('error-page.html', html);
//         console.log('🔍 Saved error-page.html for debugging\n');
//       }
//     } catch {}
    
//     throw err;
//   } finally {
//     await browser.close();
//     console.log('🔒 Browser closed\n');
//   }
// })()
//   .then(() => {
//     console.log('✅ Parser completed successfully!');
//     process.exit(0);
//   })
//   .catch((err) => {
//     console.error('💥 Critical error:', err.message);
//     process.exit(1);
//   });








// import puppeteer from 'puppeteer-extra';
// import StealthPlugin from 'puppeteer-extra-plugin-stealth';
// import fs from 'fs';

// puppeteer.use(StealthPlugin());

// const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));

// // === Получаем аргументы из командной строки ===
// const [, , productUrl, targetRegionRaw] = process.argv;

// if (!productUrl || !targetRegionRaw) {
//   console.error('Usage: node puppeteer.js <PRODUCT_URL> <REGION>');
//   console.error('Example: node puppeteer.js "https://www.vprok.ru/product/..." "Москва и область"');
//   process.exit(1);
// }

// const targetRegion = targetRegionRaw.trim();

// // === Проверка на Cloudflare / anti-bot ===
// async function waitForCloudflare(page, timeoutSec = 20) {
//   const checkPattern = /выполняется\s+проверка|checking\s+your\s+browser|Подождите|Please\s+stand\s+by/i;
//   let html = await page.content().catch(() => '');
  
//   if (!checkPattern.test(html)) return true;

//   console.warn('⚠️  Detected anti-bot check page. Waiting...');

//   const start = Date.now();
//   while ((Date.now() - start) < timeoutSec * 1000) {
//     await sleep(1000);
//     html = await page.content().catch(() => '');
//     if (!checkPattern.test(html)) {
//       console.log('✅ Anti-bot check passed\n');
//       return true;
//     }
//   }

//   console.error(`❌ Anti-bot check timeout after ${timeoutSec}s`);
//   fs.writeFileSync('cloudflare-page.html', html);
//   return false;
// }

// // === Выбор региона через модальное окно ===
// async function selectRegion(page, targetRegion) {
//   console.log(`🔄 Attempting to select region: "${targetRegion}"`);
  
//   const normalize = s => (s || '').replace(/\s+/g, ' ').trim().toLowerCase();
//   const normalizedTarget = normalize(targetRegion);

//   try {
//     // 1. Проверяем текущий регион
//     const currentRegion = await page.$eval(
//       'button[class^="Region_region__"] .Region_text__Wm7FO',
//       el => el.textContent.trim()
//     ).catch(() => null);

//     console.log(`📍 Current region: "${currentRegion || 'unknown'}"`);

//     if (currentRegion && normalize(currentRegion) === normalizedTarget) {
//       console.log(`✅ Region already correct!\n`);
//       return true;
//     }

//     // 2. Кликаем на кнопку региона
//     console.log('🖱️  Clicking region button...');
//     await page.click('button[class^="Region_region__"]');
    
//     // 3. Ждем появления модального окна с увеличенным таймаутом
//     console.log('⏳ Waiting for modal...');
//     await sleep(1500);

//     // Проверяем, что модальное окно действительно появилось
//     const modalVisible = await page.evaluate(() => {
//       const modal = document.querySelector('div[role="dialog"]');
//       return modal && modal.offsetParent !== null;
//     });

//     if (!modalVisible) {
//       console.error('❌ Modal did not appear');
//       return false;
//     }

//     console.log('✓ Modal opened');

//     // 4. Получаем список всех регионов
//     const regions = await page.$$eval(
//       'div[class^="UiRegionListBase_listWrapper__"] ul li button',
//       buttons => buttons.map(btn => btn.textContent.trim())
//     );

//     console.log(`✓ Found ${regions.length} regions:`, regions);

//     // 5. Ищем и кликаем нужный регион
//     const clicked = await page.evaluate((target) => {
//       // Нормализация внутри evaluate
//       const normalize = s => (s || '').replace(/\s+/g, ' ').trim().toLowerCase();
      
//       const buttons = document.querySelectorAll('div[class^="UiRegionListBase_listWrapper__"] ul li button');
//       const normalizedTarget = normalize(target);
      
//       for (const button of buttons) {
//         const text = button.textContent.trim();
//         const normalizedText = normalize(text);
        
//         console.log('Comparing:', normalizedText, '===', normalizedTarget);
        
//         if (normalizedText === normalizedTarget || normalizedText.includes(normalizedTarget)) {
//           console.log('MATCH! Clicking:', text);
//           button.click();
//           return text;
//         }
//       }
//       return null;
//     }, targetRegion);

//     if (!clicked) {
//       console.error(`❌ Region "${targetRegion}" not found in list`);
//       return false;
//     }

//     console.log(`✅ Clicked region: "${clicked}"`);

//     // 6. Ждем закрытия модального окна и перезагрузки данных
//     await sleep(3000);

//     // 7. Проверяем, что регион изменился
//     const newRegion = await page.$eval(
//       'button[class^="Region_region__"] .Region_text__Wm7FO',
//       el => el.textContent.trim()
//     ).catch(() => null);

//     if (newRegion && normalize(newRegion) === normalizedTarget) {
//       console.log(`✅ Region verified: "${newRegion}"\n`);
//       return true;
//     } else {
//       console.warn(`⚠️  Region verification failed. Got: "${newRegion}"\n`);
//       return false;
//     }

//   } catch (error) {
//     console.error(`❌ Failed to select region: ${error.message}\n`);
//     return false;
//   }
// }

// // === Извлечение данных о товаре ===
// async function extractProductData(page) {
//   console.log('📊 Extracting product data...\n');

//   const productData = await page.evaluate(() => {
//     const result = {
//       price: null,
//       priceOld: null,
//       rating: null,
//       reviewCount: null,
//       debug: {}
//     };

//     const extractNumber = (text) => {
//       if (!text) return null;
//       const cleaned = text.replace(/\s+/g, '').replace(',', '.');
//       const match = cleaned.match(/[\d]+\.?[\d]*/);
//       return match ? parseFloat(match[0]) : null;
//     };

//     // === ЦЕНА ===
//     console.log('Looking for price...');
//     const priceSelectors = [
//       '.Price_price__3rj7L',
//       '[class*="Price_price"]:not([class*="old"])',
//       '[data-testid="product-price"]',
//       'span[class*="price"]:not([class*="old"])'
//     ];

//     for (const selector of priceSelectors) {
//       const el = document.querySelector(selector);
//       if (el && el.textContent.includes('₽')) {
//         const price = extractNumber(el.textContent);
//         if (price && price > 0 && price < 1000000) {
//           result.price = price;
//           result.debug.priceSelector = selector;
//           console.log('Found price:', price, 'via', selector);
//           break;
//         }
//       }
//     }

//     // === СТАРАЯ ЦЕНА ===
//     console.log('Looking for old price...');
//     const oldPriceSelectors = [
//       '.Price_oldPrice__1mNRO',
//       '[class*="Price_oldPrice"]',
//       '[data-testid="product-price-old"]',
//       's',
//       'del'
//     ];

//     for (const selector of oldPriceSelectors) {
//       const el = document.querySelector(selector);
//       if (el && el.textContent.includes('₽')) {
//         const oldPrice = extractNumber(el.textContent);
//         if (oldPrice && oldPrice > (result.price || 0)) {
//           result.priceOld = oldPrice;
//           result.debug.priceOldSelector = selector;
//           console.log('Found old price:', oldPrice, 'via', selector);
//           break;
//         }
//       }
//     }

//     // === РЕЙТИНГ ===
//     console.log('Looking for rating...');
//     const ratingSelectors = [
//       '.Rating_rating__1KFrt',
//       '[class*="Rating_rating"]',
//       '[data-testid="product-rating"]',
//       '[itemprop="ratingValue"]'
//     ];

//     for (const selector of ratingSelectors) {
//       const el = document.querySelector(selector);
//       if (el) {
//         const text = el.textContent.trim();
//         const rating = extractNumber(text);
        
//         // ВАЖНО: рейтинг от 0 до 5
//         if (rating !== null && rating >= 0 && rating <= 5) {
//           result.rating = rating;
//           result.debug.ratingSelector = selector;
//           console.log('Found rating:', rating, 'via', selector);
//           break;
//         }
//       }
//     }

//     // === КОЛИЧЕСТВО ОТЗЫВОВ ===
//     console.log('Looking for review count...');
    
//     // Сначала ищем по конкретным селекторам
//     const reviewSelectors = [
//       '.Review_count__2nFJx',
//       '[class*="Review_count"]',
//       '[data-testid="product-review-count"]',
//       '[itemprop="reviewCount"]'
//     ];

//     for (const selector of reviewSelectors) {
//       const el = document.querySelector(selector);
//       if (el) {
//         const text = el.textContent.trim();
//         const count = extractNumber(text);
        
//         // ВАЖНО: количество отзывов - целое число, обычно > 0
//         if (count !== null && Number.isInteger(count) && count >= 0 && count < 100000) {
//           result.reviewCount = Math.floor(count);
//           result.debug.reviewSelector = selector;
//           console.log('Found review count:', count, 'via', selector);
//           break;
//         }
//       }
//     }

//     // Альтернативный поиск - ищем ссылку с текстом "отзыв"
//     if (result.reviewCount === null) {
//       const reviewLinks = document.querySelectorAll('a[href*="review"], button');
//       for (const el of reviewLinks) {
//         const text = el.textContent.toLowerCase();
        
//         // Проверяем что есть слово "отзыв" И число
//         if (text.includes('отзыв') && text.match(/\d+/)) {
//           const numbers = text.match(/\d+/g);
          
//           if (numbers && numbers.length > 0) {
//             // Берем первое число
//             const count = parseInt(numbers[0]);
            
//             // Проверяем что это не рейтинг (не от 0 до 5) и не ID товара (не слишком большое)
//             if (count > 5 && count < 100000) {
//               result.reviewCount = count;
//               result.debug.reviewSelector = 'link with "отзыв"';
//               console.log('Found review count:', count, 'via text search');
//               break;
//             }
//           }
//         }
//       }
//     }

//     return result;
//   });

//   // Выводим результаты
//   console.log('─────────────────────────────');
//   console.log('📊 Extraction results:');
//   console.log('─────────────────────────────');
  
//   if (productData.price !== null) {
//     console.log(`✅ Price: ${productData.price} ₽`);
//     console.log(`   Selector: ${productData.debug.priceSelector}`);
//   } else {
//     console.log(`❌ Price: NOT FOUND`);
//   }

//   if (productData.priceOld !== null) {
//     console.log(`✅ Old price: ${productData.priceOld} ₽`);
//     console.log(`   Selector: ${productData.debug.priceOldSelector}`);
//   } else {
//     console.log(`⚪ Old price: not found (no discount)`);
//   }

//   if (productData.rating !== null) {
//     console.log(`✅ Rating: ${productData.rating} / 5.0`);
//     console.log(`   Selector: ${productData.debug.ratingSelector}`);
//   } else {
//     console.log(`❌ Rating: NOT FOUND`);
//   }

//   if (productData.reviewCount !== null) {
//     console.log(`✅ Review count: ${productData.reviewCount}`);
//     console.log(`   Selector: ${productData.debug.reviewSelector}`);
//   } else {
//     console.log(`❌ Review count: NOT FOUND`);
//   }
  
//   console.log('─────────────────────────────\n');

//   return productData;
// }

// // === ГЛАВНАЯ ФУНКЦИЯ ===
// (async () => {
//   console.log('🚀 Starting parser...');
//   console.log(`📦 Product URL: ${productUrl}`);
//   console.log(`🌍 Target region: ${targetRegion}\n`);

//   const browser = await puppeteer.launch({
//     headless: false,
//     args: [
//       '--no-sandbox',
//       '--disable-setuid-sandbox',
//       '--start-maximized',
//       '--disable-blink-features=AutomationControlled'
//     ],
//     defaultViewport: null
//   });

//   const page = await browser.newPage();
//   await page.setUserAgent(
//     'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36'
//   );
//   page.setDefaultTimeout(30000);

//   // Включаем логи из браузера
//   page.on('console', msg => {
//     const text = msg.text();
//     if (text.includes('Looking for') || text.includes('Found')) {
//       console.log(`   [Browser] ${text}`);
//     }
//   });

//   try {
//     // 1. Открываем страницу товара
//     console.log('🌐 Loading product page...');
//     await page.goto(productUrl, { waitUntil: 'domcontentloaded' });
//     console.log('✓ Page loaded\n');

//     // 2. Проверяем Cloudflare
//     const cfPassed = await waitForCloudflare(page, 25);
//     if (!cfPassed) {
//       throw new Error('Anti-bot check failed');
//     }

//     // 3. Ждем загрузки основного контента
//     await sleep(2000);

//     // 4. Выбираем регион
//     const regionSuccess = await selectRegion(page, targetRegion);
//     if (!regionSuccess) {
//       console.warn('⚠️  Region selection failed, but continuing...\n');
//     }

//     // 5. Ждем загрузки данных после смены региона
//     console.log('⏳ Waiting for product data to load...');
//     await sleep(3000);

//     // Дополнительно ждем появления цены
//     try {
//       await page.waitForSelector('.Price_price__3rj7L, [class*="Price_price"]', { 
//         timeout: 10000,
//         visible: true 
//       });
//       console.log('✓ Price element visible\n');
//     } catch (e) {
//       console.warn('⚠️  Price element not found, continuing...\n');
//     }

//     // 6. Извлекаем данные о товаре
//     const productData = await extractProductData(page);

//     // 7. Сохраняем в файл product.txt
//     console.log('💾 Saving data to product.txt...');

//     const outputLines = [];
//     if (productData.price !== null) outputLines.push(`price=${productData.price}`);
//     if (productData.priceOld !== null) outputLines.push(`priceOld=${productData.priceOld}`);
//     if (productData.rating !== null) outputLines.push(`rating=${productData.rating}`);
//     if (productData.reviewCount !== null) outputLines.push(`reviewCount=${productData.reviewCount}`);

//     if (outputLines.length > 0) {
//       const content = outputLines.join('\n');
//       fs.writeFileSync('product.txt', content);
//       console.log('✅ Saved to product.txt\n');
//       console.log('📄 File content:');
//       console.log('═══════════════════════');
//       console.log(content);
//       console.log('═══════════════════════\n');
//     } else {
//       console.warn('⚠️  No data extracted!\n');
//       const html = await page.content();
//       fs.writeFileSync('debug.html', html);
//       console.log('🔍 Saved debug.html for inspection\n');
//     }

//     // 8. Делаем скриншот
//     console.log('📸 Taking screenshot...');
//     await page.screenshot({
//       path: 'screenshot.jpg',
//       fullPage: true,
//       type: 'jpeg',
//       quality: 90
//     });
//     console.log('✅ Screenshot saved: screenshot.jpg\n');

//   } catch (err) {
//     console.error('\n❌ Parser failed:', err.message);
//     console.error(err.stack);
    
//     try {
//       const html = await page.content().catch(() => null);
//       if (html) {
//         fs.writeFileSync('error-page.html', html);
//         console.log('🔍 Saved error-page.html for debugging\n');
//       }
//     } catch {}
    
//     throw err;
//   } finally {
//     await browser.close();
//     console.log('🔒 Browser closed\n');
//   }
// })()
//   .then(() => {
//     console.log('✅ Parser completed successfully!');
//     process.exit(0);
//   })
//   .catch((err) => {
//     console.error('💥 Critical error:', err.message);
//     process.exit(1);
//   });





// import puppeteer from 'puppeteer-extra';
// import StealthPlugin from 'puppeteer-extra-plugin-stealth';
// import fs from 'fs';

// puppeteer.use(StealthPlugin());

// const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));

// // === Получаем аргументы из командной строки ===
// const [, , productUrl, targetRegionRaw] = process.argv;

// if (!productUrl || !targetRegionRaw) {
//   console.error('Usage: node puppeteer.js <PRODUCT_URL> <REGION>');
//   console.error('Example: node puppeteer.js "https://www.vprok.ru/product/..." "Москва и область"');
//   process.exit(1);
// }

// const targetRegion = targetRegionRaw.trim();

// // === Проверка на Cloudflare / anti-bot ===
// async function waitForCloudflare(page, timeoutSec = 20) {
//   const checkPattern = /выполняется\s+проверка|checking\s+your\s+browser|Подождите|Please\s+stand\s+by/i;
//   let html = await page.content().catch(() => '');
  
//   if (!checkPattern.test(html)) return true;

//   console.warn('⚠️  Detected anti-bot check page. Waiting...');

//   const start = Date.now();
//   while ((Date.now() - start) < timeoutSec * 1000) {
//     await sleep(1000);
//     html = await page.content().catch(() => '');
//     if (!checkPattern.test(html)) {
//       console.log('✅ Anti-bot check passed\n');
//       return true;
//     }
//   }

//   console.error(`❌ Anti-bot check timeout after ${timeoutSec}s`);
//   fs.writeFileSync('cloudflare-page.html', html);
//   return false;
// }

// // === Выбор региона через модальное окно ===
// async function applyRegionViaModal(page, targetRegion, { retries = 3 } = {}) {
//   const norm = s => (s || '').replace(/\s+/g, ' ').trim().toLowerCase();
//   const normTarget = norm(targetRegion);

//   console.log(`🔄 Attempting to select region: "${targetRegion}"`);

//   for (let attempt = 1; attempt <= retries; attempt++) {
//     console.log(`   ▶ Attempt ${attempt}/${retries}`);

//     // 1. Ищем кнопку региона в хедере
//     const regionButtonSelector = 'button[class^="Region_region__"]';
//     const btn = await page.$(regionButtonSelector).catch(() => null);
    
//     if (!btn) {
//       console.warn('   ⚠️  Region button not found in header');
//       await sleep(1200);
//       continue;
//     }

//     console.log('   ✓ Region button found');

//     // Проверяем текущий регион
//     const currentRegion = await page.$eval(
//       `${regionButtonSelector} .Region_text__Wm7FO`,
//       el => el.textContent.trim()
//     ).catch(() => null);

//     console.log(`   📍 Current region: "${currentRegion || 'unknown'}"`);

//     // Если регион уже установлен - выходим
//     if (currentRegion && norm(currentRegion) === normTarget) {
//       console.log(`   ✅ Region already correct!\n`);
//       return true;
//     }

//     // 2. Кликаем на кнопку региона
//     console.log('   🖱️  Clicking region button...');
//     await btn.click({ delay: 100 });
//     await sleep(800);

//     // 3. Ждем появления модального окна
//     console.log('   ⏳ Waiting for modal...');
//     const modalRegionSelector = 'div[class^="UiRegionListBase_listWrapper__"] ul li button';
    
//     await page.waitForSelector(modalRegionSelector, { timeout: 3000 }).catch(() => null);
//     const regionButtons = await page.$$(modalRegionSelector);

//     if (!regionButtons || !regionButtons.length) {
//       console.warn('   ⚠️  Modal not found or empty — retrying...');
//       await sleep(1000);
//       continue;
//     }

//     console.log(`   ✓ Modal opened, found ${regionButtons.length} regions`);

//     // 4. Ищем нужный регион в списке
//     console.log(`   🔍 Searching for "${targetRegion}"...`);
    
//     let clicked = false;
//     for (const button of regionButtons) {
//       const text = await page.evaluate(el => el.innerText.trim(), button);
      
//       if (norm(text) === normTarget || norm(text).includes(normTarget)) {
//         console.log(`   ✓ Found: "${text}"`);
//         await button.click({ delay: 100 });
//         clicked = true;
//         console.log(`   ✅ Clicked!`);
//         break;
//       }
//     }

//     if (!clicked) {
//       console.warn(`   ⚠️  Target region not found in list — retrying...`);
//       await sleep(1000);
//       continue;
//     }

//     // 5. Ждем обновления страницы
//     await sleep(1500);

//     // 6. Проверяем, что регион изменился
//     const headerText = await page.$eval(
//       regionButtonSelector,
//       el => el.innerText.trim()
//     ).catch(() => null);

//     if (headerText && norm(headerText).includes(normTarget)) {
//       console.log(`   ✅ Region verified in header: "${headerText}"\n`);
//       return true;
//     }

//     console.warn('   ⚠️  Region not verified — retrying...');
//     await sleep(1000);
//   }

//   console.error('❌ Failed to apply region after all attempts\n');
//   return false;
// }

// // === Извлечение данных о товаре ===
// async function extractProductData(page) {
//   console.log('📊 Extracting product data...');

//   const htmlData = await page.evaluate(() => {
//     const result = {
//       price: null,
//       priceOld: null,
//       rating: null,
//       reviewCount: null,
//       debug: {
//         priceSelector: null,
//         priceOldSelector: null,
//         ratingSelector: null,
//         reviewSelector: null
//       }
//     };

//     // Функция поиска элемента по списку селекторов
//     const findElement = (selectors) => {
//       for (const selector of selectors) {
//         const el = document.querySelector(selector);
//         if (el && el.innerText && el.innerText.trim()) {
//           return { element: el, selector: selector };
//         }
//       }
//       return { element: null, selector: null };
//     };

//     // Функция извлечения числа
//     const extractNumber = (text) => {
//       if (!text) return null;
//       const cleaned = text.replace(/\s+/g, '').replace(',', '.');
//       const match = cleaned.match(/[\d]+\.?[\d]*/);
//       return match ? parseFloat(match[0]) : null;
//     };

//     // === ЦЕНА ===
//     const priceSelectors = [
//       '[data-testid="product-price"]',
//       '.Price_price__3rj7L',
//       'span[class*="Price_price"]:not([class*="old"])',
//       '.price',
//       '[itemprop="price"]'
//     ];

//     const priceResult = findElement(priceSelectors);
//     if (priceResult.element) {
//       result.price = extractNumber(priceResult.element.innerText);
//       result.debug.priceSelector = priceResult.selector;
//     }

//     // === СТАРАЯ ЦЕНА ===
//     const priceOldSelectors = [
//       '[data-testid="product-price-old"]',
//       '.Price_oldPrice__1mNRO',
//       'span[class*="Price_oldPrice"]',
//       '.old-price',
//       's',
//       'del'
//     ];

//     const priceOldResult = findElement(priceOldSelectors);
//     if (priceOldResult.element) {
//       const oldPrice = extractNumber(priceOldResult.element.innerText);
//       if (oldPrice && oldPrice > (result.price || 0)) {
//         result.priceOld = oldPrice;
//         result.debug.priceOldSelector = priceOldResult.selector;
//       }
//     }

//     // Альтернативный поиск зачеркнутой цены
//     if (!result.priceOld) {
//       const allElements = document.querySelectorAll('span, div');
//       for (const el of allElements) {
//         const style = window.getComputedStyle(el);
//         if (style.textDecoration.includes('line-through') && el.innerText.includes('₽')) {
//           const oldPrice = extractNumber(el.innerText);
//           if (oldPrice && oldPrice > (result.price || 0)) {
//             result.priceOld = oldPrice;
//             result.debug.priceOldSelector = 'line-through style';
//             break;
//           }
//         }
//       }
//     }

//     // === РЕЙТИНГ ===
//     const ratingSelectors = [
//       '[data-testid="product-rating"]',
//       '.Rating_rating__1KFrt',
//       'div[class*="Rating_rating"]',
//       '[itemprop="ratingValue"]',
//       '.rating'
//     ];

//     const ratingResult = findElement(ratingSelectors);
//     if (ratingResult.element) {
//       const rating = extractNumber(ratingResult.element.innerText);
//       if (rating !== null && rating >= 0 && rating <= 5) {
//         result.rating = rating;
//         result.debug.ratingSelector = ratingResult.selector;
//       }
//     }

//     // === КОЛИЧЕСТВО ОТЗЫВОВ ===
//     const reviewSelectors = [
//       '[data-testid="product-review-count"]',
//       '.Review_count__2nFJx',
//       'span[class*="Review_count"]',
//       '[itemprop="reviewCount"]',
//       'a[href*="review"]',
//       '.reviews'
//     ];

//     const reviewResult = findElement(reviewSelectors);
//     if (reviewResult.element) {
//       const count = extractNumber(reviewResult.element.innerText);
//       if (count !== null && count >= 0) {
//         result.reviewCount = count;
//         result.debug.reviewSelector = reviewResult.selector;
//       }
//     }

//     // Альтернативный поиск отзывов
//     if (result.reviewCount === null) {
//       const allElements = document.querySelectorAll('span, div, a, button');
//       for (const el of allElements) {
//         const text = el.innerText.toLowerCase();
//         if (text.includes('отзыв') || text.includes('оценк')) {
//           const count = extractNumber(el.innerText);
//           if (count !== null && count >= 0 && count < 1000000) {
//             result.reviewCount = count;
//             result.debug.reviewSelector = 'text search (отзыв)';
//             break;
//           }
//         }
//       }
//     }

//     return result;
//   });

//   // Выводим результаты с подробностями
//   console.log('📊 Extraction results:');
  
//   if (htmlData.price !== null) {
//     console.log(`   ├─ ✅ Price: ${htmlData.price} ₽`);
//     console.log(`   │  └─ selector: ${htmlData.debug.priceSelector}`);
//   } else {
//     console.log(`   ├─ ❌ Price: NOT FOUND`);
//   }

//   if (htmlData.priceOld !== null) {
//     console.log(`   ├─ ✅ Old price: ${htmlData.priceOld} ₽`);
//     console.log(`   │  └─ selector: ${htmlData.debug.priceOldSelector}`);
//   } else {
//     console.log(`   ├─ ⚪ Old price: not found (no discount)`);
//   }

//   if (htmlData.rating !== null) {
//     console.log(`   ├─ ✅ Rating: ${htmlData.rating}`);
//     console.log(`   │  └─ selector: ${htmlData.debug.ratingSelector}`);
//   } else {
//     console.log(`   ├─ ❌ Rating: NOT FOUND`);
//   }

//   if (htmlData.reviewCount !== null) {
//     console.log(`   └─ ✅ Review count: ${htmlData.reviewCount}`);
//     console.log(`      └─ selector: ${htmlData.debug.reviewSelector}\n`);
//   } else {
//     console.log(`   └─ ❌ Review count: NOT FOUND\n`);
//   }

//   return htmlData;
// }

// // === ГЛАВНАЯ ФУНКЦИЯ ===
// (async () => {
//   console.log('🚀 Starting parser...');
//   console.log(`📦 Product URL: ${productUrl}`);
//   console.log(`🌍 Target region: ${targetRegion}\n`);

//   const browser = await puppeteer.launch({
//     headless: false,
//     args: [
//       '--no-sandbox',
//       '--disable-setuid-sandbox',
//       '--start-maximized',
//       '--disable-blink-features=AutomationControlled'
//     ],
//     defaultViewport: null
//   });

//   const page = await browser.newPage();
//   await page.setUserAgent(
//     'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36'
//   );
//   page.setDefaultTimeout(30000);

//   try {
//     // 1. Открываем страницу товара
//     console.log('🌐 Loading product page...');
//     await page.goto(productUrl, { waitUntil: 'domcontentloaded' });
//     console.log('✓ Page loaded\n');

//     // 2. Проверяем Cloudflare
//     const cfPassed = await waitForCloudflare(page, 25);
//     if (!cfPassed) {
//       throw new Error('Anti-bot check failed');
//     }

//     // 3. Пробуем применить регион через API
//     console.log('🔧 Trying to apply region via API...');
//     const regionApplied = await page.evaluate((targetRegion) => {
//       if (!window.regionList) return false;
//       const region = window.regionList.find(r => r.name === targetRegion);
//       if (!region) return false;
//       try {
//         window.selectRegion(region.regionId);
//         return true;
//       } catch {
//         return false;
//       }
//     }, targetRegion);

//     if (regionApplied) {
//       console.log(`✅ Region applied via API: "${targetRegion}"\n`);
//     } else {
//       console.warn('⚠️  API method failed, using modal fallback...\n');
//       await applyRegionViaModal(page, targetRegion);
//     }

//     // 4. Ждем обновления данных после смены региона
//     console.log('⏳ Waiting for page update after region change...');
//     await sleep(2000);
//     console.log('✓ Ready to extract data\n');

//     // 5. Извлекаем данные о товаре
//     const htmlData = await extractProductData(page);

//     // 6. Сохраняем в файл product.txt
//     console.log('💾 Saving data to product.txt...');

//     const outputLines = [];
//     if (htmlData.price !== null) outputLines.push(`price=${htmlData.price}`);
//     if (htmlData.priceOld !== null) outputLines.push(`priceOld=${htmlData.priceOld}`);
//     if (htmlData.rating !== null) outputLines.push(`rating=${htmlData.rating}`);
//     if (htmlData.reviewCount !== null) outputLines.push(`reviewCount=${htmlData.reviewCount}`);

//     if (outputLines.length > 0) {
//       const content = outputLines.join('\n');
//       fs.writeFileSync('product.txt', content);
//       console.log('✅ Data saved to product.txt\n');
//       console.log('📄 File content:');
//       console.log('─────────────────────');
//       console.log(content);
//       console.log('─────────────────────\n');
//     } else {
//       console.warn('⚠️  No data extracted!\n');
//       const html = await page.content();
//       fs.writeFileSync('debug.html', html);
//       console.log('🔍 Saved debug.html for inspection\n');
//     }

//     // 7. Делаем скриншот
//     console.log('📸 Taking screenshot...');
//     const dims = await page.evaluate(() => ({
//       w: document.documentElement.scrollWidth,
//       h: document.documentElement.scrollHeight
//     })).catch(() => ({ w: 0, h: 0 }));

//     if (dims.w > 0 && dims.h > 0) {
//       await page.screenshot({
//         path: 'screenshot.jpg',
//         fullPage: true,
//         type: 'jpeg',
//         quality: 90
//       });
//       console.log('✅ Screenshot saved: screenshot.jpg\n');
//     }

//   } catch (err) {
//     console.error('\n❌ Parser failed:', err.message || err);
    
//     try {
//       const html = await page.content().catch(() => null);
//       if (html) {
//         fs.writeFileSync('error-page.html', html);
//         console.log('🔍 Saved error-page.html for debugging\n');
//       }
//     } catch {}
    
//     throw err;
//   } finally {
//     await browser.close();
//     console.log('🔒 Browser closed\n');
//   }
// })()
//   .then(() => {
//     console.log('✅ Parser completed successfully!');
//     process.exit(0);
//   })
//   .catch((err) => {
//     console.error('💥 Critical error:', err.message);
//     process.exit(1);
//   });













// import puppeteer from 'puppeteer-extra';
// import StealthPlugin from 'puppeteer-extra-plugin-stealth';
// import fs from 'fs';

// puppeteer.use(StealthPlugin());

// const sleep = ms => new Promise(res => setTimeout(res, ms));

// const [, , productUrl, targetRegionRaw] = process.argv;
// if (!productUrl || !targetRegionRaw) {
//   console.error('Usage: node puppeteerParser.js <PRODUCT_URL> <REGION>');
//   process.exit(1);
// }
// const targetRegion = targetRegionRaw.trim();

// async function waitForCloudflare(page, timeoutSec = 20) {
//   const checkPattern = /выполняется\s+проверка|checking\s+your\s+browser|Подождите|Please\s+stand\s+by/i;
//   let html = await page.content().catch(()=>'');
//   if (!checkPattern.test(html)) return true;

//   console.warn('⚠️ Detected anti-bot / browser check page. Waiting for it to pass...');

//   const start = Date.now();
//   while ((Date.now() - start) < timeoutSec * 1000) {
//     await sleep(1000);
//     html = await page.content().catch(()=> '');
//     if (!checkPattern.test(html)) {
//       console.log('✅ Anti-bot check passed (page changed).');
//       return true;
//     }
//   }

//   console.error(`💥 Anti-bot check did not finish after ${timeoutSec}s`);
//   try { fs.writeFileSync('browser_check_page.html', html); } catch {}
//   return false;
// }

// // --- Новый метод выбора региона через модальное окно ---
// async function applyRegionViaModal(page, targetRegion, { retries = 3 } = {}) {
//   const norm = s => (s || '').replace(/\s+/g,' ').trim().toLowerCase();
//   const normTarget = norm(targetRegion);

//   console.log(`🔄 Applying region via modal: "${targetRegion}"`);

//   for (let attempt = 1; attempt <= retries; attempt++) {
//     console.log(`  ▶ Attempt ${attempt}/${retries}`);

//     const regionButtonSelector = 'button[class^="Region_region__"]';
//     const btn = await page.$(regionButtonSelector).catch(()=>null);
//     if (!btn) {
//       console.warn('⚠️ Header region button not found');
//       await page.waitForTimeout(1200);
//       continue;
//     }

//     await btn.click({ delay: 100 });
//     await page.waitForTimeout(800); // анимация открытия

//     const modalRegionSelector = 'div[class^="UiRegionListBase_listWrapper__"] ul li button';
//     await page.waitForSelector(modalRegionSelector, { timeout: 3000 }).catch(()=>null);
//     const regionButtons = await page.$$(modalRegionSelector);

//     if (!regionButtons || !regionButtons.length) {
//       console.warn('⚠️ Modal with regions not found — retrying...');
//       await page.waitForTimeout(1000);
//       continue;
//     }

//     console.log(`    Found ${regionButtons.length} regions in modal`);

//     let clicked = false;
//     for (const b of regionButtons) {
//       const text = await page.evaluate(el => el.innerText.trim(), b);
//       if (norm(text).includes(normTarget)) {
//         await b.click({ delay: 100 });
//         clicked = true;
//         console.log(`    ✅ Clicked region: "${text}"`);
//         break;
//       }
//     }

//     if (!clicked) {
//       console.warn('⚠️ Target region not found in modal — retrying...');
//       await page.waitForTimeout(1000);
//       continue;
//     }

//     await page.waitForTimeout(1500);
//     const headerText = await page.$eval(regionButtonSelector, el => el.innerText.trim()).catch(()=>null);
//     if (headerText && norm(headerText).includes(normTarget)) {
//       console.log(`    ✅ Region verified in header: "${headerText}"`);
//       return true;
//     }

//     console.warn('    Region click did not verify — retrying...');
//     await page.waitForTimeout(1000);
//   }

//   console.error('⚠️ Region not applied via modal after all attempts');
//   return false;
// }

// // --- Основная функция ---
// (async () => {
//   const browser = await puppeteer.launch({
//     headless: false,
//     args: [
//       '--no-sandbox',
//       '--disable-setuid-sandbox',
//       '--start-maximized',
//       '--disable-blink-features=AutomationControlled'
//     ],
//     defaultViewport: null
//   });

//   const page = await browser.newPage();
//   await page.setUserAgent('Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36');
//   page.setDefaultTimeout(30000);

//   try {
//     console.log('🚀 Starting parser...');
//     console.log(`📦 Product URL: ${productUrl}`);
//     console.log(`🌍 Target region: ${targetRegion}`);

//     await page.goto(productUrl, { waitUntil: 'domcontentloaded' });
//     console.log('✓ Page loaded');

//     const cfPassed = await waitForCloudflare(page, 25);
//     if (!cfPassed) throw new Error('Anti-bot check not passed');

//     // --- Попытка применить регион через regionList API ---
//     const regionApplied = await page.evaluate((targetRegion) => {
//       if (!window.regionList) return false;
//       const r = window.regionList.find(r => r.name === targetRegion);
//       if (!r) return false;
//       try { window.selectRegion(r.regionId); return true; } catch { return false; }
//     }, targetRegion);

//     if (regionApplied) {
//       console.log(`✅ Region applied via regionList API: "${targetRegion}"`);
//     } else {
//       console.warn('⚠️ regionList not found or region API failed, fallback to modal...');
//       await applyRegionViaModal(page, targetRegion);
//     }

//     await sleep(1200);

//     // --- Извлечение данных ---
//     const htmlData = await page.evaluate(() => {
//       const get = selectors => {
//         for (const s of selectors) {
//           const el = document.querySelector(s);
//           if (el && el.innerText && el.innerText.trim()) return el.innerText.trim();
//         }
//         return null;
//       };
//       const priceTxt = get(['[data-testid="product-price"]', '.Price_price', '.price', '[itemprop="price"]']);
//       const priceOldTxt = get(['[data-testid="product-price-old"]', '.Price_oldPrice', '.old-price', 's, del']);
//       const ratingTxt = get(['[data-testid="product-rating"]', '[itemprop="ratingValue"]', '.rating']);
//       const reviewsTxt = get(['[data-testid="product-review-count"]', '[itemprop="reviewCount"]', '.reviews']);

//       const num = t => {
//         if (!t) return null;
//         const cleaned = t.replace(/\s+/g,'').replace(',','.');
//         const m = cleaned.match(/[\d]+\.?[\d]*/);
//         return m ? parseFloat(m[0]) : null;
//       };

//       return {
//         price: num(priceTxt),
//         priceOld: num(priceOldTxt),
//         rating: num(ratingTxt),
//         reviewCount: num(reviewsTxt)
//       };
//     });

//     console.log('📊 HTML extraction results:', htmlData);

//     const out = [];
//     for (const [k,v] of Object.entries(htmlData)) if (v != null) out.push(`${k}=${v}`);
//     fs.writeFileSync('product.txt', out.join('\n'));
//     console.log('💾 Data saved to product.txt');

//     const dims = await page.evaluate(() => ({ w: document.documentElement.scrollWidth, h: document.documentElement.scrollHeight })).catch(()=>({w:0,h:0}));
//     if (dims.w > 0 && dims.h > 0) {
//       await page.screenshot({ path: 'screenshot.jpg', fullPage: true });
//       console.log('📸 Screenshot saved: screenshot.jpg');
//     }

//   } catch (err) {
//     console.error('💥 Parser failed:', err.message || err);
//     try {
//       const html = await page.content().catch(()=>null);
//       if (html) fs.writeFileSync('error_page.html', html);
//       console.log('🧩 Saved error_page.html for debugging');
//     } catch {}
//   } finally {
//     await browser.close();
//     console.log('🔒 Browser closed');
//   }
// })();










// // puppeteerParser.js
// import puppeteer from 'puppeteer-extra';
// import StealthPlugin from 'puppeteer-extra-plugin-stealth';
// import fs from 'fs';

// puppeteer.use(StealthPlugin());

// const sleep = ms => new Promise(res => setTimeout(res, ms));

// const [, , productUrl, targetRegionRaw] = process.argv;
// if (!productUrl || !targetRegionRaw) {
//   console.error('Usage: node puppeteerParser.js <PRODUCT_URL> <REGION>');
//   process.exit(1);
// }
// const targetRegion = targetRegionRaw.trim();

// // --- Ожидание Cloudflare/антибота ---
// async function waitForCloudflare(page, timeoutSec = 20) {
//   const checkPattern = /выполняется\s+проверка|checking\s+your\s+browser|Подождите|Please\s+stand\s+by/i;
//   let html = await page.content().catch(()=>'');
//   if (!checkPattern.test(html)) return true;

//   console.warn('⚠️ Detected anti-bot / browser check page. Waiting...');
//   const start = Date.now();
//   while ((Date.now() - start) < timeoutSec * 1000) {
//     await sleep(1000);
//     html = await page.content().catch(()=> '');
//     if (!checkPattern.test(html)) {
//       console.log('✅ Anti-bot check passed');
//       return true;
//     }
//   }
//   console.error(`💥 Anti-bot check did not finish after ${timeoutSec}s`);
//   try { fs.writeFileSync('browser_check_page.html', html); } catch {}
//   return false;
// }

// // --- Новый applyRegion с разбором текста модалки ---
// async function applyRegion(page, targetRegion, { retries = 3 } = {}) {
//   const norm = s => (s || '').replace(/\s+/g,' ').trim().toLowerCase();
//   const normTarget = norm(targetRegion);
//   console.log(`🔄 Applying region via modal: "${targetRegion}"`);

//   for (let attempt = 1; attempt <= retries; attempt++) {
//     console.log(`  ▶ Attempt ${attempt}/${retries}`);

//     // 1) Находим кнопку региона в шапке
//     const headerSelectors = [
//       '[data-testid="region-header-link"]',
//       '.header__region',
//       '.header [class*="region"]',
//       'button[class*="region"]',
//       'a[class*="region"]'
//     ];
//     let headerHandle = null;
//     for (const sel of headerSelectors) {
//       try { headerHandle = await page.$(sel); } catch {}
//       if (headerHandle) break;
//     }
//     if (!headerHandle) {
//       console.warn('⚠️ Header region button not found');
//       await sleep(1200);
//       continue;
//     }

//     const headerText = await page.evaluate(el => el.innerText?.trim(), headerHandle).catch(()=> '');
//     console.log(`    Header candidate found: "${headerText}"`);

//     try {
//       await headerHandle.evaluate(el => el.scrollIntoView({ block: 'center' }));
//       await headerHandle.click({ delay: 100 });
//     } catch { try { await page.evaluate(el => el.click(), headerHandle); } catch {} }
//     await sleep(1000);

//     // 2) Ждём модалку
//     const modalSelectors = ['div[role="dialog"]', '.region-list', 'ul[class*="regions"]'];
//     let modalHandle = null;
//     for (const ms of modalSelectors) {
//       try { modalHandle = await page.$(ms); } catch {}
//       if (modalHandle) break;
//     }
//     if (!modalHandle) {
//       console.warn('    Modal with regions not found — retrying...');
//       await sleep(1200);
//       continue;
//     }
//     console.log('    ✓ Modal appeared');

//     // 3) Получаем текст модалки и разбиваем на строки
//     const modalText = await page.evaluate(modal => modal.innerText, modalHandle);
//     const lines = modalText.split('\n').map(l => l.trim()).filter(Boolean);
//     console.log('    Modal lines:', lines);

//     // 4) Находим нужный регион
//     const matchLine = lines.find(l => norm(l).includes(normTarget));
//     if (!matchLine) {
//       console.warn(`    ⚠️ Target region "${targetRegion}" not found in modal lines`);
//       await sleep(1200);
//       continue;
//     }
//     console.log(`    ✅ Match line: "${matchLine}"`);

//     // 5) Находим DOM элемент и кликаем
//     const escaped = matchLine.replace(/"/g, '\\"');
//     const xpath = `//*[contains(normalize-space(string(.)), "${escaped}")]`;
//     const handles = await page.$x(xpath).catch(()=>[]);
//     if (!handles.length) {
//       console.warn('    ⚠️ Could not find DOM element for matched region — retrying');
//       await sleep(1000);
//       continue;
//     }

//     let clicked = false;
//     for (const h of handles) {
//       try { await h.evaluate(el => el.scrollIntoView({ block: 'center' })); await h.click({ delay: 80 }); clicked = true; break; } catch {}
//     }
//     if (!clicked) { console.warn('    ⚠️ Click failed — retrying'); await sleep(1000); continue; }

//     // 6) Ждём обновления заголовка и куки
//     await sleep(1800);
//     const newHeader = await page.evaluate(() => {
//       const s = document.querySelector('[data-testid="region-header-link"], .header__region, .header [class*="region"], [class*="region"]');
//       return s ? s.innerText.trim() : null;
//     }).catch(()=>null);

//     const cookies = await page.cookies().catch(()=>[]);
//     const regionCookie = cookies.find(c => /region/i.test(c.name) || /region/i.test(c.value));

//     if ((newHeader && norm(newHeader).includes(normTarget)) ||
//         (regionCookie && norm(regionCookie.value).includes(normTarget.split(' ')[0]))) {
//       console.log(`    ✅ Region successfully applied: "${targetRegion}"`);
//       return true;
//     }

//     console.warn('    ⚠️ Region click did not verify — retrying...');
//     await sleep(1000);
//   }
//   return false;
// }

// // --- Основной парсер ---
// (async () => {
//   const browser = await puppeteer.launch({
//     headless: false,
//     args: ['--no-sandbox','--disable-setuid-sandbox','--start-maximized','--disable-blink-features=AutomationControlled'],
//     defaultViewport: null
//   });
//   const page = await browser.newPage();
//   await page.setUserAgent('Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36');
//   page.setDefaultTimeout(30000);

//   try {
//     console.log('🚀 Starting parser...');
//     console.log(`📦 Product URL: ${productUrl}`);
//     console.log(`🌍 Target region: ${targetRegion}`);

//     await page.goto(productUrl, { waitUntil: 'domcontentloaded' });
//     console.log('✓ Page loaded');

//     const cfPassed = await waitForCloudflare(page, 25);
//     if (!cfPassed) throw new Error('Anti-bot check not passed');

//     const ok = await applyRegion(page, targetRegion, { retries: 3 });
//     if (!ok) console.warn('⚠️ Region not verified - continuing with default region');

//     await sleep(1200);

//     // --- Извлечение данных ---
//     const htmlData = await page.evaluate(() => {
//       const get = selectors => {
//         for (const s of selectors) {
//           const el = document.querySelector(s);
//           if (el && el.innerText && el.innerText.trim()) return el.innerText.trim();
//         }
//         return null;
//       };
//       const priceTxt = get(['[data-testid="product-price"]', '.Price_price', '.price', '[itemprop="price"]']);
//       const priceOldTxt = get(['[data-testid="product-price-old"]', '.Price_oldPrice', '.old-price', 's, del']);
//       const ratingTxt = get(['[data-testid="product-rating"]', '[itemprop="ratingValue"]', '.rating']);
//       const reviewsTxt = get(['[data-testid="product-review-count"]', '[itemprop="reviewCount"]', '.reviews']);

//       const num = t => {
//         if (!t) return null;
//         const cleaned = t.replace(/\s+/g,'').replace(',','.');
//         const m = cleaned.match(/[\d]+\.?[\d]*/);
//         return m ? parseFloat(m[0]) : null;
//       };

//       return {
//         price: num(priceTxt),
//         priceOld: num(priceOldTxt),
//         rating: num(ratingTxt),
//         reviewCount: num(reviewsTxt)
//       };
//     });

//     console.log('📊 HTML extraction results:', htmlData);

//     const out = [];
//     for (const [k,v] of Object.entries(htmlData)) if (v != null) out.push(`${k}=${v}`);
//     fs.writeFileSync('product.txt', out.join('\n'));
//     console.log('💾 Data saved to product.txt');

//     // --- Скриншот ---
//     const dims = await page.evaluate(() => ({ w: document.documentElement.scrollWidth, h: document.documentElement.scrollHeight })).catch(()=>({w:0,h:0}));
//     if (dims.w > 0 && dims.h > 0) {
//       await page.screenshot({ path: 'screenshot.jpg', fullPage: true });
//       console.log('📸 Screenshot saved: screenshot.jpg');
//     } else console.warn('⚠️ Page dimensions 0 — skipping screenshot');

//   } catch (err) {
//     console.error('💥 Parser failed:', err.message || err);
//     try {
//       const html = await page.content().catch(()=>null);
//       if (html) fs.writeFileSync('error_page.html', html);
//       console.log('🧩 Saved error_page.html for debugging');
//     } catch {}
//   } finally {
//     await browser.close();
//     console.log('🔒 Browser closed');
//   }
// })();





// import puppeteer from 'puppeteer-extra';
// import StealthPlugin from 'puppeteer-extra-plugin-stealth';
// import fs from 'fs';

// puppeteer.use(StealthPlugin());

// const sleep = ms => new Promise(res => setTimeout(res, ms));

// const [, , productUrl, targetRegionRaw] = process.argv;
// if (!productUrl || !targetRegionRaw) {
//   console.error('Usage: node puppeteerParser.js <PRODUCT_URL> <REGION>');
//   process.exit(1);
// }
// const targetRegion = targetRegionRaw.trim();

// // --- Ожидание Cloudflare/anti-bot ---
// async function waitForCloudflare(page, timeoutSec = 20) {
//   const checkPattern = /выполняется\s+проверка|checking\s+your\s+browser|Подождите|Please\s+stand\s+by/i;
//   let html = await page.content().catch(()=>'');
//   if (!checkPattern.test(html)) return true;

//   console.warn('⚠️ Detected anti-bot / browser check page. Waiting...');
//   const start = Date.now();
//   while ((Date.now() - start) < timeoutSec * 1000) {
//     await sleep(1000);
//     html = await page.content().catch(()=> '');
//     if (!checkPattern.test(html)) {
//       console.log('✅ Anti-bot check passed');
//       return true;
//     }
//   }
//   console.error(`💥 Anti-bot check did not finish after ${timeoutSec}s`);
//   fs.writeFileSync('browser_check_page.html', html);
//   return false;
// }

// // --- Применение региона с автоскроллом и безопасным кликом ---
// async function applyRegion(page, targetRegion, { retries = 3 } = {}) {
//   const norm = s => (s || '').replace(/\s+/g,' ').trim().toLowerCase();
//   const normTarget = norm(targetRegion);
//   console.log(`🔄 Applying region: "${targetRegion}"`);

//   for (let attempt = 1; attempt <= retries; attempt++) {
//     console.log(`  ▶ attempt ${attempt}/${retries}`);

//     // 1) ищем кнопку региона
//     const headerSelectors = [
//       '[data-testid="region-header-link"]',
//       '[data-testid*="region"]',
//       'button[class*="region"]',
//       'a[class*="region"]',
//       '.header [class*="region"]',
//       '.header__region',
//     ];

//     let headerHandle = null;
//     for (const sel of headerSelectors) {
//       headerHandle = await page.$(sel).catch(()=>null);
//       if (headerHandle) break;
//     }

//     if (headerHandle) {
//       const text = await page.evaluate(el => el.innerText?.trim() || '', headerHandle).catch(()=> '');
//       console.log(`    header candidate found: "${text?.slice(0,120)}"`);

//       // автоскролл перед кликом
//       await headerHandle.evaluate(el => el.scrollIntoView({behavior:'smooth', block:'center'}));
//       await sleep(800);
//       try { await headerHandle.click({delay:100}); } catch { 
//         await page.evaluate(el=>el.click(), headerHandle).catch(()=>{}); 
//       }
//       await sleep(900);
//     }

//     // 2) собираем все кликабельные элементы
//     const candidates = await page.evaluate(() => {
//       const els = Array.from(document.querySelectorAll('button, a, [role="button"], span, div'));
//       return els.filter(e => {
//         const txt = e.innerText?.trim();
//         const style = window.getComputedStyle(e);
//         return txt && txt.length < 250 && style && style.display !== 'none' && style.visibility !== 'hidden' && parseFloat(style.opacity)!==0;
//       }).map(e=>e.innerText.trim());
//     }).catch(()=>[]);

//     if(!candidates.length){
//       console.log('    no clickable candidates found, retrying...');
//       await sleep(1200);
//       continue;
//     }

//     // 3) ищем лучший совпадающий регион
//     let bestMatch = candidates.find(c=>norm(c) === normTarget || norm(c).includes(normTarget));
//     if(!bestMatch) {
//       const token = normTarget.split(' ')[0];
//       bestMatch = candidates.find(c=>norm(c).includes(token));
//     }
//     if(!bestMatch){
//       console.log('    no matching candidate found this attempt');
//       await sleep(1200);
//       continue;
//     }
//     console.log(`    best match: "${bestMatch}" — attempting to click`);

//     // 4) кликаем через page.evaluate (без $x)
//     const clicked = await page.evaluate((text)=>{
//       const el = Array.from(document.querySelectorAll('button, a, [role="button"], span, div'))
//         .find(e=>e.innerText?.trim() === text);
//       if(el){ el.scrollIntoView({behavior:'smooth', block:'center'}); el.click(); return true; }
//       return false;
//     }, bestMatch);

//     if(!clicked){
//       console.warn('    click failed — retrying attempt');
//       await sleep(900);
//       continue;
//     }

//     // 5) проверяем по заголовку или cookie
//     await sleep(1800);
//     const headerText = await page.evaluate(()=>{
//       const s = document.querySelector('[data-testid="region-header-link"], .header__region, .header [class*="region"], [class*="region"]');
//       return s ? s.innerText.trim() : null;
//     }).catch(()=>null);

//     if(headerText && norm(headerText).includes(normTarget)) return true;

//     const cookies = await page.cookies().catch(()=>[]);
//     const rc = cookies.find(c=>/region/i.test(c.name) || /region/i.test(c.value));
//     if(rc && norm(rc.value).includes(normTarget.split(' ')[0])) return true;

//     console.warn('    region click did not verify — retrying');
//     await sleep(900);
//   }

//   return false;
// }

// // --- Основной код ---
// (async () => {
//   const browser = await puppeteer.launch({
//     headless: false,
//     args: ['--no-sandbox','--disable-setuid-sandbox','--start-maximized','--disable-blink-features=AutomationControlled'],
//     defaultViewport: null
//   });

//   const page = await browser.newPage();
//   await page.setUserAgent('Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36');
//   page.setDefaultTimeout(30000);

//   try {
//     console.log('🚀 Starting parser...');
//     console.log(`📦 Product URL: ${productUrl}`);
//     console.log(`🌍 Target region: ${targetRegion}`);

//     await page.goto(productUrl, { waitUntil: 'domcontentloaded' });
//     console.log('✓ Page loaded');

//     const cfPassed = await waitForCloudflare(page, 25);
//     if(!cfPassed) throw new Error('Anti-bot check not passed');

//     const ok = await applyRegion(page, targetRegion, { retries: 3 });
//     if(!ok) console.warn('⚠️ Region not verified — proceeding with default region');

//     await sleep(1200);

//     // --- Извлечение данных ---
//     const htmlData = await page.evaluate(() => {
//       const get = selectors => selectors.map(s=>document.querySelector(s)?.innerText?.trim()).find(Boolean);
//       const priceTxt = get(['[data-testid="product-price"]', '.Price_price', '.price', '[itemprop="price"]']);
//       const priceOldTxt = get(['[data-testid="product-price-old"]', '.Price_oldPrice', '.old-price', 's, del']);
//       const ratingTxt = get(['[data-testid="product-rating"]', '[itemprop="ratingValue"]', '.rating']);
//       const reviewsTxt = get(['[data-testid="product-review-count"]', '[itemprop="reviewCount"]', '.reviews']);

//       const num = t => t ? parseFloat(t.replace(/\s+/g,'').replace(',','.').match(/[\d]+\.?[\d]*/)?.[0]||null) : null;

//       return { price:num(priceTxt), priceOld:num(priceOldTxt), rating:num(ratingTxt), reviewCount:num(reviewsTxt) };
//     });

//     console.log('📊 HTML extraction results:', htmlData);

//     const out = Object.entries(htmlData).filter(([_,v])=>v!=null).map(([k,v])=>`${k}=${v}`);
//     fs.writeFileSync('product.txt', out.join('\n'));
//     console.log('💾 Data saved to product.txt');

//     const dims = await page.evaluate(()=>({w:document.documentElement.scrollWidth, h:document.documentElement.scrollHeight})).catch(()=>({w:0,h:0}));
//     if(dims.w>0 && dims.h>0){ 
//       await page.screenshot({ path: 'screenshot.jpg', fullPage:true }); 
//       console.log('📸 Screenshot saved'); 
//     }

//   } catch(err){
//     console.error('💥 Parser failed:', err.message||err);
//     const html = await page.content().catch(()=>null);
//     if(html) fs.writeFileSync('error_page.html', html);
//     console.log('🧩 Saved error_page.html');
//   } finally {
//     await browser.close();
//     console.log('🔒 Browser closed');
//   }
// })();













// // puppeteerParser.js
// import puppeteer from 'puppeteer-extra';
// import StealthPlugin from 'puppeteer-extra-plugin-stealth';
// import fs from 'fs';

// puppeteer.use(StealthPlugin());

// const sleep = ms => new Promise(res => setTimeout(res, ms));

// const [, , productUrl, targetRegionRaw] = process.argv;
// if (!productUrl || !targetRegionRaw) {
//   console.error('Usage: node puppeteerParser.js <PRODUCT_URL> <REGION>');
//   process.exit(1);
// }
// const targetRegion = targetRegionRaw.trim();

// async function waitForCloudflare(page, timeoutSec = 20) {
//   // Если видим текст проверки браузера — ждём редиректа / завершения проверки
//   const checkPattern = /выполняется\s+проверка|checking\s+your\s+browser|Подождите|Please\s+stand\s+by/i;
//   let html = await page.content().catch(()=>'');
//   if (!checkPattern.test(html)) return true;

//   console.warn('⚠️ Detected anti-bot / browser check page. Waiting for it to pass...');

//   const start = Date.now();
//   while ((Date.now() - start) < timeoutSec * 1000) {
//     await sleep(1000);
//     html = await page.content().catch(()=>'');
//     if (!checkPattern.test(html)) {
//       console.log('✅ Anti-bot check passed (page changed).');
//       return true;
//     }
//   }

//   console.error(`💥 Anti-bot check did not finish after ${timeoutSec}s`);
//   // save snapshot for debugging
//   try { fs.writeFileSync('browser_check_page.html', html); } catch {}
//   return false;
// }

// async function applyRegion(page, targetRegion, { retries = 3 } = {}) {
//   const norm = s => (s || '').replace(/\s+/g,' ').trim().toLowerCase();
//   const normTarget = norm(targetRegion);
//   console.log(`🔄 Applying region: "${targetRegion}"`);

//   for (let attempt = 1; attempt <= retries; attempt++) {
//     console.log(`  ▶ attempt ${attempt}/${retries}`);

//     // 1) Try obvious header selectors
//     const headerSelectors = [
//       '[data-testid="region-header-link"]',
//       '[data-testid*="region"]',
//       'button[class*="region"]',
//       'a[class*="region"]',
//       '.header [class*="region"]',
//       '.header__region',
//     ];

//     let headerHandle = null;
//     for (const sel of headerSelectors) {
//       try {
//         headerHandle = await page.$(sel);
//       } catch {}
//       if (headerHandle) break;
//     }

//     if (headerHandle) {
//       const text = await page.evaluate(el => el.innerText?.trim() || el.textContent || '', headerHandle).catch(()=> '');
//       console.log(`    header candidate found: "${(text||'').slice(0,120)}"`);
//       try {
//         await headerHandle.evaluate(el => el.scrollIntoView({block:'center'}));
//         await headerHandle.click({ delay: 100 });
//       } catch {
//         try { await page.evaluate(el => el.click(), headerHandle); } catch {}
//       }
//       await sleep(900);
//     } else {
//       console.log('    header region button not found by common selectors.');
//     }

//     // 2) Wait for modal OR scan clickable elements
//     const modalSelectors = [
//       'div[role="dialog"]',
//       'div[class*="region-list"]',
//       'ul[class*="regions"]',
//       '.region-list'
//     ];

//     let candidates = [];

//     // if modal appears, gather its items
//     for (const ms of modalSelectors) {
//       const modal = await page.$(ms).catch(()=>null);
//       if (modal) {
//         // gather items inside modal
//         candidates = await page.$$eval(
//           `${ms} li, ${ms} button, ${ms} a, ${ms} [role="button"]`,
//           nodes => nodes.map(n => n.innerText?.replace(/\s+/g,' ').trim()).filter(Boolean)
//         ).catch(()=>[]);
//         if (candidates.length) {
//           console.log(`    modal "${ms}" yielded ${candidates.length} items (showing first 20)`);
//           candidates.slice(0,20).forEach((c,i)=> console.log(`      ${i+1}. ${c}`));
//           break;
//         }
//       }
//     }

//     // if no modal items — fallback: scan visible clickable elements (limit)
//     if (!candidates.length) {
//       console.log('    modal not found — scanning clickable elements fallback (buttons/links/spans)...');
//       candidates = await page.$$eval(
//         'button, a, [role="button"], span, div',
//         (els) => {
//           const out = [];
//           for (let i=0; i<els.length && out.length < 400; i++) {
//             const e = els[i];
//             const txt = e.innerText?.replace(/\s+/g,' ').trim();
//             if (!txt || txt.length > 250) continue;
//             const style = window.getComputedStyle(e);
//             if (!style || style.display === 'none' || style.visibility === 'hidden' || parseFloat(style.opacity) === 0) continue;
//             out.push(txt);
//           }
//           return out;
//         }
//       ).catch(()=>[]);
//       console.log(`    scanned ${candidates.length} clickable elements (showing first 30)`);
//       candidates.slice(0,30).forEach((c,i)=> console.log(`      ${i+1}. ${c}`));
//     }

//     // 3) find best match
//     let bestIdx = -1;
//     for (let i=0;i<candidates.length;i++){
//       const t = norm(candidates[i] || '');
//       if (!t) continue;
//       if (t === normTarget) { bestIdx = i; break; }
//       if (t.includes(normTarget)) { bestIdx = i; break; }
//     }
//     if (bestIdx === -1) {
//       // try partial word match
//       const token = normTarget.split(' ')[0];
//       for (let i=0;i<candidates.length;i++){
//         if (norm(candidates[i]||'').includes(token)) { bestIdx = i; break; }
//       }
//     }

//     if (bestIdx === -1) {
//       console.log('    no matching candidate found this attempt');
//       await sleep(1200);
//       continue;
//     }

//     const matchText = candidates[bestIdx];
//     console.log(`    best match: "${matchText}" — attempting to click it`);

//     // 4) click element by XPath matching text snippet (best-effort)
//     const escaped = matchText.replace(/"/g, '\\"');
//     const xpath = `//*[contains(normalize-space(string(.)), "${escaped}")]`;
//     const handles = await page.$x(xpath).catch(()=>[]);
//     let clicked = false;
//     if (handles && handles.length) {
//       for (const h of handles) {
//         const txt = await page.evaluate(el => el.innerText?.replace(/\s+/g,' ').trim(), h).catch(()=>'');
//         if (!txt) continue;
//         if (txt.slice(0,200) === matchText || txt.includes(matchText) || matchText.includes(txt)) {
//           try {
//             await h.evaluate(el=>el.scrollIntoView({block:'center'})).catch(()=>{});
//             await h.click({ delay: 80 }).catch(async ()=>{ await page.evaluate(el=>el.click(), h).catch(()=>{}); });
//             clicked = true;
//             break;
//           } catch (e) { /* try next handle */ }
//         }
//       }
//     }

//     if (!clicked) {
//       console.warn('    clicking candidate failed — retrying attempt');
//       await sleep(900);
//       continue;
//     }

//     // 5) wait and verify
//     await sleep(1800);
//     // verify by header text
//     const headerText = await page.evaluate(() => {
//       const s = document.querySelector('[data-testid="region-header-link"], .header__region, .header [class*="region"], [class*="region"]');
//       return s ? s.innerText.trim() : null;
//     }).catch(()=>null);

//     if (headerText && norm(headerText).includes(normTarget)) {
//       console.log(`    ✅ Verified region by header: "${headerText}"`);
//       return true;
//     }

//     // verify by cookies
//     const cookies = await page.cookies().catch(()=>[]);
//     const rc = cookies.find(c => /region/i.test(c.name) || /region/i.test(c.value));
//     if (rc) {
//       console.log(`    🍪 Region cookie: ${rc.name}=${rc.value}`);
//       if (norm(rc.value).includes(normTarget.split(' ')[0])) return true;
//     }

//     // not verified: try again
//     console.warn('    region click did not verify — will retry if attempts left');
//     await sleep(900);
//   } // attempts

//   return false;
// }

// (async () => {
//   // Launch with stealth-friendly args
//   const browser = await puppeteer.launch({
//     headless: false,
//     args: [
//       '--no-sandbox',
//       '--disable-setuid-sandbox',
//       '--start-maximized',
//       '--disable-blink-features=AutomationControlled'
//     ],
//     defaultViewport: null
//   });

//   const page = await browser.newPage();
//   // set a realistic user-agent
//   await page.setUserAgent('Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36');
//   page.setDefaultTimeout(30000);

//   try {
//     console.log('🚀 Starting parser...');
//     console.log(`📦 Product URL: ${productUrl}`);
//     console.log(`🌍 Target region: ${targetRegion}`);

//     await page.goto(productUrl, { waitUntil: 'domcontentloaded' });
//     console.log('✓ Page loaded');

//     // Wait and handle Cloudflare/anti-bot check
//     const cfPassed = await waitForCloudflare(page, 25);
//     if (!cfPassed) {
//       throw new Error('Anti-bot check not passed');
//     }

//     // Apply region
//     const ok = await applyRegion(page, targetRegion, { retries: 3 });
//     if (!ok) console.warn('⚠️ Region not verified - continuing but results may be from default region');

//     await sleep(1200);

//     // Extract data (fallback selectors)
//     const htmlData = await page.evaluate(() => {
//       const get = selectors => {
//         for (const s of selectors) {
//           const el = document.querySelector(s);
//           if (el && el.innerText && el.innerText.trim()) return el.innerText.trim();
//         }
//         return null;
//       };
//       const priceTxt = get(['[data-testid="product-price"]', '.Price_price', '.price', '[itemprop="price"]']);
//       const priceOldTxt = get(['[data-testid="product-price-old"]', '.Price_oldPrice', '.old-price', 's, del']);
//       const ratingTxt = get(['[data-testid="product-rating"]', '[itemprop="ratingValue"]', '.rating']);
//       const reviewsTxt = get(['[data-testid="product-review-count"]', '[itemprop="reviewCount"]', '.reviews']);

//       const num = t => {
//         if (!t) return null;
//         const cleaned = t.replace(/\s+/g,'').replace(',','.');
//         const m = cleaned.match(/[\d]+\.?[\d]*/);
//         return m ? parseFloat(m[0]) : null;
//       };

//       return {
//         price: num(priceTxt),
//         priceOld: num(priceOldTxt),
//         rating: num(ratingTxt),
//         reviewCount: num(reviewsTxt)
//       };
//     });

//     console.log('📊 HTML extraction results:', htmlData);

//     // Save product.txt (simple key=value lines)
//     const out = [];
//     for (const [k,v] of Object.entries(htmlData)) if (v != null) out.push(`${k}=${v}`);
//     fs.writeFileSync('product.txt', out.join('\n'));
//     console.log('💾 Data saved to product.txt');

//     // Safe screenshot
//     const dims = await page.evaluate(() => ({ w: document.documentElement.scrollWidth, h: document.documentElement.scrollHeight })).catch(()=>({w:0,h:0}));
//     if (dims.w > 0 && dims.h > 0) {
//       await page.screenshot({ path: 'screenshot.jpg', fullPage: true });
//       console.log('📸 Screenshot saved: screenshot.jpg');
//     } else {
//       console.warn('⚠️ Page dimensions 0 — skipping screenshot');
//     }

//   } catch (err) {
//     console.error('💥 Parser failed:', err.message || err);
//     try {
//       const html = await page.content().catch(()=>null);
//       if (html) fs.writeFileSync('error_page.html', html);
//       console.log('🧩 Saved error_page.html for debugging');
//     } catch {}
//   } finally {
//     await browser.close();
//     console.log('🔒 Browser closed');
//   }
// })();







// import puppeteer from "puppeteer";
// import fs from "fs";

// const sleep = (ms) => new Promise(resolve => setTimeout(resolve, ms));

// const [, , productUrl, targetRegion] = process.argv;

// if (!productUrl || !targetRegion) {
//   console.error("Usage: node puppeteer.js <productUrl> <regionName>");
//   process.exit(1);
// }

// async function parseProduct(url, regionName) {
//   console.log(`🚀 Starting parser...\n📦 Product URL: ${url}\n🌍 Target region: ${regionName}\n`);

//   const browser = await puppeteer.launch({ headless: false, args: ['--start-maximized'] });
//   const page = await browser.newPage();
//   await page.setViewport({ width: 1920, height: 1080 });
//   page.setDefaultTimeout(30000);

//   try {
//     console.log("🌐 Navigating to product page...");
//     await page.goto(url, { waitUntil: "networkidle2" });
//     console.log("✓ Page loaded\n");

//     // --- Меняем регион через модальное окно ---
//     console.log(`🔄 Changing region to "${regionName}"...`);

//     try {
//       const regionButtonSelector = '[data-testid="region-header-link"], button[class*="Region"]';
//       await page.waitForSelector(regionButtonSelector, { timeout: 5000 });
//       const regionButton = await page.$(regionButtonSelector);
//       await regionButton.click();
//       await sleep(2000);

//       const modalSelector = 'div[role="dialog"] ul, div[class*="region-list"]';
//       await page.waitForSelector(modalSelector, { timeout: 5000 });

//       const regionApplied = await page.evaluate((regionName) => {
//         const items = document.querySelectorAll('div[role="dialog"] li, div[class*="region-list"] li');
//         for (const item of items) {
//           if (item.textContent.includes(regionName)) {
//             item.click();
//             return true;
//           }
//         }
//         return false;
//       }, regionName);

//       if (!regionApplied) {
//         console.warn(`⚠️ Region "${regionName}" not found in modal list`);
//       } else {
//         console.log(`✅ Region "${regionName}" selected, waiting for page reload...`);
//         await page.waitForNavigation({ waitUntil: "networkidle2" });
//         await sleep(2000);
//       }
//     } catch (err) {
//       console.warn(`⚠️ Failed to change region: ${err.message}`);
//     }

//     // --- Извлекаем данные из HTML ---
//     console.log("📄 Extracting data from HTML DOM...");
//     const data = await page.evaluate(() => {
//       const extractNumber = (text) => {
//         if (!text) return null;
//         const cleaned = text.replace(/\s+/g, '').replace(',', '.');
//         const match = cleaned.match(/[\d]+\.?[\d]*/);
//         return match ? parseFloat(match[0]) : null;
//       };

//       const priceEl = document.querySelector('[class*="Price_price"]:not([class*="old"]), [data-testid*="price"], [itemprop="price"]');
//       const oldPriceEl = document.querySelector('[class*="Price_oldPrice"], [class*="oldPrice"], s, del');

//       const ratingEl = document.querySelector('[class*="Rating"], [itemprop="ratingValue"], [data-testid*="rating"]');
//       const reviewEl = document.querySelector('[class*="Review"], [itemprop="reviewCount"], a[href*="review"]');

//       return {
//         price: extractNumber(priceEl?.textContent),
//         priceOld: extractNumber(oldPriceEl?.textContent),
//         rating: extractNumber(ratingEl?.textContent),
//         reviewCount: extractNumber(reviewEl?.textContent)
//       };
//     });

//     console.log(`📊 Extracted data: ${JSON.stringify(data)}`);

//     // --- Сохраняем данные в файл ---
//     let content = "";
//     if (data.price !== null) content += `price=${data.price}\n`;
//     if (data.priceOld !== null) content += `priceOld=${data.priceOld}\n`;
//     if (data.rating !== null) content += `rating=${data.rating}\n`;
//     if (data.reviewCount !== null) content += `reviewCount=${data.reviewCount}\n`;

//     if (content) {
//       fs.writeFileSync('product.txt', content.trim());
//       console.log("💾 Data saved to product.txt");
//     } else {
//       console.warn("⚠️ No data extracted, check the page manually.");
//     }

//     // --- Скриншот ---
//     await page.screenshot({ path: "screenshot.jpg", fullPage: true });
//     console.log("📸 Screenshot saved: screenshot.jpg");

//   } catch (err) {
//     console.error("❌ Parser failed:", err);
//   } finally {
//     await browser.close();
//     console.log("🔒 Browser closed");
//   }
// }

// parseProduct(productUrl, targetRegion);












// const applyRegion = async (page, targetRegion) => {
//   console.log(`🔄 Changing region to "${targetRegion}"...`);

//   // Проверяем текущий регион
//   const currentRegion = await page.evaluate(() => {
//     const el = document.querySelector('[class*="Region"] [class*="text"], [class*="region"] span');
//     return el?.textContent?.trim() || null;
//   });

//   if (currentRegion?.toLowerCase() === targetRegion.toLowerCase()) {
//     console.log(`✅ Region already set: "${currentRegion}"`);
//     return true;
//   }

//   // Находим кнопку региона
//   let regionButton;
//   try {
//     regionButton = await page.waitForSelector(
//       'button:has([class*="Region"]), [class*="region"], [data-testid*="region"]',
//       { visible: true, timeout: 7000 }
//     );
//   } catch {
//     console.warn('⚠️ Region button not found on page');
//     return false;
//   }

//   console.log('✓ Region button found, clicking...');
//   await page.evaluate(el => el.scrollIntoView({ behavior: "smooth", block: "center" }), regionButton);
//   try {
//     await regionButton.click();
//   } catch {
//     await page.evaluate(el => el.click(), regionButton);
//   }

//   await sleep(1500);

//   // Ждём появления модалки
//   await page.waitForSelector(
//     'div[role="dialog"], [class*="Modal"], [class*="region-list"], [class*="region"] ul',
//     { visible: true, timeout: 8000 }
//   ).catch(() => console.warn('⚠️ Region modal did not appear'));

//   // Ищем регион в модалке
//   const regionApplied = await page.evaluate((target) => {
//     const selectors = [
//       'div[role="dialog"] li',
//       'div[role="dialog"] button',
//       '[class*="region-list"] li',
//       '[class*="region"] li',
//       '[class*="region"] button',
//       'ul li',
//       'ul button'
//     ];

//     let found = false;
//     for (const sel of selectors) {
//       const items = document.querySelectorAll(sel);
//       for (const item of items) {
//         const text = item.textContent?.trim();
//         if (!text) continue;
//         if (text.toLowerCase().includes(target.toLowerCase())) {
//           item.scrollIntoView({ behavior: "smooth", block: "center" });
//           item.click();
//           found = true;
//           break;
//         }
//       }
//       if (found) break;
//     }
//     return found;
//   }, targetRegion);

//   if (!regionApplied) {
//     console.warn(`⚠️ Region "${targetRegion}" not found in modal list`);
//     return false;
//   }

//   console.log(`🕒 Waiting for page to update region...`);
//   await page.waitForNavigation({ waitUntil: "networkidle2" }).catch(() => {});
//   await sleep(2500);

//   // Проверяем, что регион реально изменился
//   const appliedCheck = await page.evaluate((target) => {
//     const el = document.querySelector('[class*="Region"] [class*="text"], [class*="region"] span');
//     const text = el?.textContent?.trim()?.toLowerCase() || "";
//     return text.includes(target.toLowerCase());
//   }, targetRegion);

//   if (appliedCheck) console.log(`✅ Region successfully applied: "${targetRegion}"`);
//   else console.warn(`⚠️ Region "${targetRegion}" might not have been applied`);

//   return appliedCheck;
// };



// import puppeteer from "puppeteer";
// import fs from "fs";

// const sleep = (ms) => new Promise(resolve => setTimeout(resolve, ms));

// const [, , productUrl, targetRegion] = process.argv;

// if (!productUrl || !targetRegion) {
//   console.error("Usage: node puppeteer.js <productUrl> <regionName>");
//   console.error('Example: node puppeteer.js "https://www.vprok.ru/product/..." "Москва"');
//   process.exit(1);
// }

// async function changeRegion(page, targetRegion) {
//   console.log(`🔄 Changing region to "${targetRegion}"...`);

//   // Получаем JSON со списком доступных регионов
//   const regionResponse = await page.evaluate(async () => {
//     try {
//       const res = await fetch('https://www.vprok.ru/web/api/v1/regionList');
//       if (!res.ok) return null;
//       return await res.json();
//     } catch {
//       return null;
//     }
//   });

//   if (!regionResponse || !regionResponse.regionList) {
//     console.warn('⚠️ Could not fetch region list from API');
//     return false;
//   }

//   const targetRegionObj = regionResponse.regionList.find(
//     r => r.name.toLowerCase() === targetRegion.toLowerCase()
//   );

//   if (!targetRegionObj) {
//     console.warn(`⚠️ Region "${targetRegion}" not found in API list`);
//     return false;
//   }

//   console.log(`✓ Found region in API: "${targetRegionObj.name}" (regionId=${targetRegionObj.regionId})`);

//   // Нажимаем на кнопку смены региона
//   const regionButton = await page.$('button[class*="region"], div[class*="Region"]');
//   if (regionButton) {
//     await regionButton.click();
//     await sleep(1000);
//   }

//   // Устанавливаем нужный регион через API
//   await page.evaluate(async (regionId) => {
//     await fetch('/web/api/v1/setRegion', {
//       method: 'POST',
//       headers: { 'Content-Type': 'application/json' },
//       body: JSON.stringify({ regionId })
//     });
//   }, targetRegionObj.regionId);

//   console.log(`✅ Region changed to "${targetRegionObj.name}"`);
//   await sleep(3000); // ждем перезагрузки страницы
//   return true;
// }

// async function parseProduct(url, regionName) {
//   console.log('\n🚀 Starting parser...');
//   console.log(`📦 Product URL: ${url}`);
//   console.log(`🌍 Target region: ${regionName}\n`);

//   const browser = await puppeteer.launch({
//     headless: false,
//     args: ['--start-maximized']
//   });

//   const page = await browser.newPage();
//   await page.setViewport({ width: 1920, height: 1080 });
//   page.setDefaultTimeout(20000);

//   const apiData = { responses: [] };

//   try {
//     // Перехват API
//     await page.setRequestInterception(true);
//     page.on('request', req => req.continue());
//     page.on('response', async response => {
//       const url = response.url();
//       if (response.status() === 200 && response.headers()['content-type']?.includes('application/json')) {
//         try {
//           const data = await response.json();
//           if (url.includes('/product') || url.includes('/api')) {
//             apiData.responses.push({ url, data });
//           }
//         } catch {}
//       }
//     });

//     console.log('🌐 Navigating to product page...');
//     await page.goto(url, { waitUntil: "networkidle2" });
//     await sleep(2000);

//     // Определяем текущий регион
//     const currentRegion = await page.evaluate(() => {
//       const el = document.querySelector('[class*="Region"] [class*="text"]') ||
//                  document.querySelector('button[class*="region"]');
//       return el ? el.textContent.trim() : null;
//     });

//     if (!currentRegion || currentRegion.toLowerCase() !== regionName.toLowerCase()) {
//       await changeRegion(page, regionName);
//     } else {
//       console.log(`✅ Region already correct: "${currentRegion}"`);
//     }

//     await sleep(2000); // ждем загрузки контента после смены региона

//     // --- HTML-парсинг ---
//     const htmlData = await page.evaluate(() => {
//       const extractNumber = (text) => {
//         if (!text) return null;
//         const cleaned = text.replace(/\s+/g, '').replace(',', '.');
//         const match = cleaned.match(/[\d]+\.?[\d]*/);
//         return match ? parseFloat(match[0]) : null;
//       };

//       const result = { price: null, priceOld: null, rating: null, reviewCount: null };

//       const priceEl = document.querySelector('[class*="Price_price"]:not([class*="old"]), span[class*="price"]:not([class*="old"])');
//       if (priceEl) result.price = extractNumber(priceEl.textContent);

//       const oldPriceEl = document.querySelector('[class*="oldPrice"], s, del');
//       if (oldPriceEl) result.priceOld = extractNumber(oldPriceEl.textContent);

//       const ratingEl = document.querySelector('[class*="Rating"], [itemprop="ratingValue"]');
//       if (ratingEl) result.rating = extractNumber(ratingEl.textContent);

//       const reviewEl = document.querySelector('[class*="Review"], [itemprop="reviewCount"]');
//       if (reviewEl) result.reviewCount = parseInt(reviewEl.textContent) || null;

//       return result;
//     });

//     // --- API-парсинг ---
//     const apiExtractedData = { price: null, priceOld: null, rating: null, reviewCount: null };
//     const findInObject = (obj, keys, depth = 0, maxDepth = 5) => {
//       if (!obj || typeof obj !== 'object' || depth > maxDepth) return null;
//       for (const key of keys) if (obj[key] !== undefined) return obj[key];
//       for (const val of Object.values(obj)) if (val && typeof val === 'object') {
//         const found = findInObject(val, keys, depth + 1, maxDepth);
//         if (found !== null) return found;
//       }
//       return null;
//     };

//     apiData.responses.forEach(resp => {
//       apiExtractedData.price ||= findInObject(resp.data, ['price', 'actual', 'current', 'value']);
//       apiExtractedData.priceOld ||= findInObject(resp.data, ['priceOld', 'old', 'was']);
//       apiExtractedData.rating ||= findInObject(resp.data, ['rating', 'averageRating']);
//       apiExtractedData.reviewCount ||= findInObject(resp.data, ['reviewCount', 'reviewsCount']);
//     });

//     // --- Объединяем данные ---
//     const finalData = {
//       price: apiExtractedData.price || htmlData.price,
//       priceOld: apiExtractedData.priceOld || htmlData.priceOld,
//       rating: apiExtractedData.rating || htmlData.rating,
//       reviewCount: apiExtractedData.reviewCount || htmlData.reviewCount
//     };

//     console.log('📊 Final combined data:', finalData);

//     // --- Сохраняем ---
//     let fileContent = '';
//     if (finalData.price !== null) fileContent += `price=${finalData.price}\n`;
//     if (finalData.priceOld !== null) fileContent += `priceOld=${finalData.priceOld}\n`;
//     if (finalData.rating !== null) fileContent += `rating=${finalData.rating}\n`;
//     if (finalData.reviewCount !== null) fileContent += `reviewCount=${finalData.reviewCount}\n`;

//     if (fileContent) {
//       fs.writeFileSync('product.txt', fileContent.trim());
//       console.log('💾 Data saved to product.txt');
//     }

//     // --- Скриншот ---
//     await page.screenshot({ path: "screenshot.jpg", fullPage: true, type: 'jpeg', quality: 90 });

//   } catch (err) {
//     console.error('❌ Error:', err);
//   } finally {
//     await browser.close();
//     console.log('🔒 Browser closed');
//   }
// }

// parseProduct(productUrl, targetRegion);





// #!/usr/bin/env node
// import puppeteer from "puppeteer";

// const delay = ms => new Promise(res => setTimeout(res, ms));
// const clean = v => (v ? v.toString().replace(/\s/g, "").replace("₽", "").replace(",", ".") : null);

// const COLORS = {
//   reset: "\x1b[0m",
//   blue: "\x1b[34m",
//   green: "\x1b[32m",
//   red: "\x1b[31m",
//   yellow: "\x1b[33m",
// };

// const [,, productUrl, region] = process.argv;
// if (!productUrl || !region) {
//   console.error("Usage: node puppeteerParser.js <URL> \"<Region>\"");
//   process.exit(1);
// }

// const SELECTORS = {
//   regionBtn: 'button[data-testid*="region"], div[data-testid*="region"]',
//   regionInput: 'input[type="text"], input[placeholder*="поиск"]',
//   regionSelected: 'button[data-testid*="region"] span, div[data-testid*="region"] span'
// };

// async function setRegion(page, region) {
//   try {
//     const btn = await page.$(SELECTORS.regionBtn);
//     if (!btn) return false;
//     await btn.click();

//     const input = await page.$(SELECTORS.regionInput);
//     if (input) {
//       await input.type(region, { delay: 100 });
//       await page.keyboard.press('Enter');
//       await page.waitForTimeout(2000); // ждём перерендера React
//     }

//     // Проверяем выбранный регион
//     const selectedRegion = await page.evaluate(sel => {
//       const el = document.querySelector(sel);
//       return el?.textContent?.trim() || null;
//     }, SELECTORS.regionSelected);

//     if (selectedRegion === region) {
//       console.log(`${COLORS.green}✅ Region selected correctly:${COLORS.reset} ${selectedRegion}`);
//       return true;
//     } else {
//       console.log(`${COLORS.yellow}⚠️ Region selection mismatch. Current:${COLORS.reset} ${selectedRegion}`);
//       return false;
//     }
//   } catch (e) {
//     console.log(`${COLORS.yellow}Region selection skipped:${COLORS.reset} ${e.message}`);
//     return false;
//   }
// }

// (async () => {
//   const browser = await puppeteer.launch({
//     headless: false, // режим отладки: видим страницу
//     args: ['--no-sandbox', '--disable-setuid-sandbox']
//   });

//   const page = await browser.newPage();
//   await page.setViewport({ width: 1280, height: 1024 });
//   await page.setCacheEnabled(false);

//   let xhrData = { price: null, priceOld: null, rating: null, reviewCount: null };

//   page.on('response', async response => {
//     try {
//       const ct = response.headers()['content-type'] || '';
//       if (!ct.includes('application/json')) return;
//       const text = await response.text();
//       if (!text.includes('actualPrice')) return;
//       const data = JSON.parse(text);
//       const product = data?.product || data?.products?.[0] || data?.currentProduct;
//       if (product) {
//         xhrData.price = product.actualPrice?.value ?? xhrData.price;
//         xhrData.priceOld = product.regularPrice?.value ?? xhrData.priceOld;
//       }
//     } catch {}
//   });

//   try {
//     console.log(`${COLORS.blue}Loading product:${COLORS.reset} ${productUrl}`);
//     console.log(`${COLORS.blue}Region:${COLORS.reset} ${region}`);

//     await page.goto(productUrl, { waitUntil: 'networkidle2', timeout: 60000 });

//     const regionOk = await setRegion(page, region);
//     if (!regionOk) {
//       console.log(`${COLORS.red}⚠️ Region may not be applied correctly. Prices might be wrong.${COLORS.reset}`);
//     }

//     // Ждем финальный рендер React
//     await page.waitForSelector('div[itemprop="offers"] meta[itemprop="price"]', { timeout: 15000 });
//     await delay(2000); // небольшая пауза для окончательной отрисовки

//     const htmlData = await page.evaluate(() => {
//       const getMeta = sel => document.querySelector(sel)?.getAttribute('content') || null;
//       return {
//         priceHtml: getMeta('div[itemProp="offers"] meta[itemProp="price"]'),
//         priceOldHtml: getMeta('div[itemProp="offers"] meta[itemProp="priceOld"]'),
//         rating: getMeta('section[itemProp="aggregateRating"] meta[itemProp="ratingValue"]'),
//         reviewCount: getMeta('section[itemProp="aggregateRating"] meta[itemProp="reviewCount"]')
//       };
//     });

//     const finalData = {
//       price: clean(htmlData.priceHtml) ?? clean(xhrData.price),
//       priceOld: clean(htmlData.priceOldHtml) ?? clean(xhrData.priceOld),
//       rating: clean(htmlData.rating),
//       reviewCount: clean(htmlData.reviewCount)
//     };

//     console.log(`${COLORS.blue}HTML data:${COLORS.reset}`, htmlData);
//     console.log(`${COLORS.green}XHR data:${COLORS.reset}`, xhrData);

//     console.log(`
// price=${finalData.price ?? 'null'}
// priceOld=${finalData.priceOld ?? 'null'}
// rating=${finalData.rating ?? 'null'}
// reviewCount=${finalData.reviewCount ?? 'null'}
// `);

//     // Скрываем хедер и всплывашки перед скриншотом
//     await page.evaluate(() => {
//       const selectorsToHide = [
//         'header',
//         'div.CategorySelectorWrapper',
//         'div.PopupWrapper',
//         'div[class*="cookie"]',
//         'div[class*="banner"]',
//         'footer'
//       ];
//       selectorsToHide.forEach(sel =>
//         document.querySelectorAll(sel).forEach(el => (el.style.display = 'none'))
//       );
//     });

//     // Скриншот после окончательного рендера
//     await delay(2000);
//     await page.screenshot({ path: 'screenshot.jpg', fullPage: true });
//     console.log('Full-page screenshot saved: screenshot.jpg');

//   } finally {
//     await browser.close();
//     console.log(`${COLORS.green}Done${COLORS.reset}`);
//   }
// })();







// #!/usr/bin/env node
// import puppeteer from "puppeteer";

// const delay = ms => new Promise(res => setTimeout(res, ms));
// const clean = v => (v ? v.toString().replace(/\s/g, "").replace("₽", "").replace(",", ".") : null);

// const COLORS = {
//   reset: "\x1b[0m",
//   blue: "\x1b[34m",
//   green: "\x1b[32m",
//   yellow: "\x1b[33m",
// };

// const [,, productUrl, region] = process.argv;
// if (!productUrl || !region) {
//   console.error("Usage: node puppeteerParser.js <URL> \"<Region>\"");
//   process.exit(1);
// }

// const SELECTORS = {
//   regionBtn: 'button[data-testid*="region"], div[data-testid*="region"]',
//   regionInput: 'input[type="text"], input[placeholder*="поиск"]',
// };

// async function setRegion(page, region) {
//   try {
//     const btn = await page.$(SELECTORS.regionBtn);
//     if (!btn) return;
//     await btn.click();

//     const input = await page.$(SELECTORS.regionInput);
//     if (input) {
//       await input.type(region, { delay: 100 });
//       await page.keyboard.press('Enter');
//       await page.waitForNavigation({ waitUntil: 'networkidle2', timeout: 10000 }).catch(() => {});
//       console.log(`${COLORS.green}Region selected:${COLORS.reset} ${region}`);
//     }
//   } catch (e) {
//     console.log(`${COLORS.yellow}Region selection skipped:${COLORS.reset} ${e.message}`);
//   }
// }

// (async () => {
//   const browser = await puppeteer.launch({
//     headless: false, // Режим отладки: можно видеть страницу
//     args: ['--no-sandbox', '--disable-setuid-sandbox'],
//   });

//   const page = await browser.newPage();
//   await page.setViewport({ width: 1280, height: 1024 });
//   await page.setCacheEnabled(false);

//   // Чистый объект XHR-данных
//   let xhrData = { price: null, priceOld: null, rating: null, reviewCount: null, url: null };

//   // Перехват XHR
//   page.on('response', async response => {
//     try {
//       const ct = response.headers()['content-type'] || '';
//       if (!ct.includes('application/json')) return;
//       const text = await response.text();
//       if (!text.includes('actualPrice')) return;

//       const data = JSON.parse(text);
//       const product = data?.product || data?.products?.[0] || data?.currentProduct;
//       if (product) {
//         xhrData.price = product.actualPrice?.value ?? xhrData.price;
//         xhrData.priceOld = product.regularPrice?.value ?? xhrData.priceOld;
//         xhrData.url = response.url();
//       }
//     } catch {}
//   });

//   try {
//     console.log(`${COLORS.blue}Loading product:${COLORS.reset} ${productUrl}`);
//     console.log(`${COLORS.blue}Region:${COLORS.reset} ${region}`);

//     await page.goto(productUrl, { waitUntil: 'networkidle2', timeout: 60000 });
//     await setRegion(page, region);

//     // Ждём, пока React окончательно отрисует карточку товара
//     await page.waitForSelector('div[itemprop="offers"] meta[itemprop="price"]', { timeout: 15000 });
//     await delay(2000); // Дополнительно ждём подстановки React

//     // Проверяем, что цена обновилась корректно
//     await page.waitForFunction(
//       () => {
//         const meta = document.querySelector('div[itemprop="offers"] meta[itemprop="price"]');
//         return meta && parseFloat(meta.getAttribute('content')) > 0;
//       },
//       { timeout: 10000 }
//     );

//     // Извлекаем данные из meta-тегов после окончательного рендера
//     const htmlData = await page.evaluate(() => {
//       const getMeta = sel => document.querySelector(sel)?.getAttribute('content') || null;
//       return {
//         priceHtml: getMeta('div[itemProp="offers"] meta[itemprop="price"]'),
//         priceOldHtml: getMeta('div[itemProp="offers"] meta[itemprop="priceOld"]'),
//         rating: getMeta('section[itemProp="aggregateRating"] meta[itemprop="ratingValue"]'),
//         reviewCount: getMeta('section[itemProp="aggregateRating"] meta[itemprop="reviewCount"]')
//       };
//     });

//     const finalData = {
//       price: clean(htmlData.priceHtml) ?? clean(xhrData.price),
//       priceOld: clean(htmlData.priceOldHtml) ?? clean(xhrData.priceOld),
//       rating: clean(htmlData.rating),
//       reviewCount: clean(htmlData.reviewCount)
//     };

//     console.log(`${COLORS.blue}HTML data:${COLORS.reset}`, htmlData);
//     console.log(`${COLORS.green}XHR data:${COLORS.reset}`, xhrData);

//     console.log(`
// price=${finalData.price ?? 'null'}
// priceOld=${finalData.priceOld ?? 'null'}
// rating=${finalData.rating ?? 'null'}
// reviewCount=${finalData.reviewCount ?? 'null'}
// `);

//     // Скрываем хедер, баннеры, всплывашки
//     await page.evaluate(() => {
//       const selectorsToHide = [
//         'header',
//         'div.CategorySelectorWrapper',
//         'div.PopupWrapper',
//         'div[class*="cookie"]',
//         'div[class*="banner"]',
//         'footer'
//       ];
//       selectorsToHide.forEach(sel =>
//         document.querySelectorAll(sel).forEach(el => (el.style.display = 'none'))
//       );
//     });

    // // Делаем полный скриншот **после окончательного рендера**
    // await delay(2000); // небольшая пауза для финальной отрисовки
    // await page.screenshot({ path: 'screenshot.jpg', fullPage: true });
    // console.log('Full-page screenshot saved: screenshot.jpg');

//   } finally {
//     await browser.close();
//     console.log(`${COLORS.green}Done${COLORS.reset}`);
//   }
// })();









// import puppeteer from "puppeteer";

// const delay = ms => new Promise(res => setTimeout(res, ms));
// const clean = v => (v ? v.toString().replace(/\s/g, "").replace("₽","").replace(",",".") : null);

// // ANSI цвета
// const COLORS = {
//   reset: "\x1b[0m",
//   blue: "\x1b[34m",
//   green: "\x1b[32m",
//   red: "\x1b[31m",
//   yellow: "\x1b[33m"
// };

// const [,, productUrl, region] = process.argv;
// if (!productUrl || !region) {
//   console.error("Usage: node puppeteerParser.js <URL> \"<Region>\"");
//   process.exit(1);
// }

// const SELECTORS = {
//   regionBtn: 'button[data-testid*="region"], div[data-testid*="region"]',
//   regionInput: 'input[type="text"], input[placeholder*="поиск"]',
//   regionOption: 'button, a, li, div[role="button"]'
// };

// async function setRegion(page, region) {
//   try {
//     const btn = await page.$(SELECTORS.regionBtn);
//     if (!btn) return;
//     await btn.click();

//     const input = await page.$(SELECTORS.regionInput);
//     if (input) {
//       await input.type(region, { delay: 100 });
//       await page.keyboard.press('Enter');
//       await page.waitForNavigation({ waitUntil: 'networkidle2', timeout: 10000 }).catch(() => {});
//       console.log(`${COLORS.green}Region selected:${COLORS.reset} ${region}`);
//     }
//   } catch (e) {
//     console.log(`${COLORS.yellow}Region selection skipped:${COLORS.reset} ${e.message}`);
//   }
// }

// (async () => {
//   const browser = await puppeteer.launch({ headless: true });
//   const page = await browser.newPage();
//   await page.setViewport({ width: 1200, height: 800 });

//   let xhrData = {
//     price: null,
//     priceOld: null,
//     rating: null,
//     reviewCount: null,
//     url: null
//   };

//   // Перехват XHR
//   page.on('response', async response => {
//     try {
//       const ct = response.headers()['content-type'] || '';
//       if (!ct.includes('application/json')) return;
//       const text = await response.text();
//       if (!text.includes('actualPrice')) return;
//       const data = JSON.parse(text);
//       const product = data?.product || data?.products?.[0] || data?.currentProduct;
//       if (product) {
//         xhrData.price = product.actualPrice?.value ?? xhrData.price;
//         xhrData.priceOld = product.regularPrice?.value ?? xhrData.priceOld;
//         xhrData.url = response.url();
//       }
//     } catch {}
//   });

//   try {
//     console.log(`${COLORS.blue}Loading product:${COLORS.reset} ${productUrl}`);
//     console.log(`${COLORS.blue}Region:${COLORS.reset} ${region}`);

//     await page.goto(productUrl, { waitUntil: 'networkidle2', timeout: 60000 });
//     await setRegion(page, region);

//     // Ждем XHR до 5 секунд
//     const start = Date.now();
//     while (Date.now() - start < 5000) {
//       await delay(200);
//     }

//     // Данные из HTML
//     const htmlData = await page.evaluate(() => {
//       const getText = sel => document.querySelector(sel)?.textContent?.trim() || null;
//       const getMeta = sel => document.querySelector(sel)?.getAttribute('content') || null;

//       return {
//         priceHtml: getText('.Price_price__QzA8L.Price_size_XL__MHvC1.Price_role_regular__X6X4D') ||
//                    getMeta('div[itemProp="offers"] meta[itemProp="price"]'),
//         priceOldHtml: getText('.Price_price__QzA8L.Price_size_XS__ESEhJ.Price_role_old__r1uT1') ||
//                       getMeta('div[itemProp="offers"] meta[itemProp="priceOld"]'),
//         rating: getMeta('section[itemProp="aggregateRating"] meta[itemProp="ratingValue"]'),
//         reviewCount: getMeta('section[itemProp="aggregateRating"] meta[itemProp="reviewCount"]')
//       };
//     });

//     const finalData = {
//       price: clean(htmlData.priceHtml) ?? clean(xhrData.price),
//       priceOld: clean(htmlData.priceOldHtml) ?? clean(xhrData.priceOld),
//       rating: clean(htmlData.rating),
//       reviewCount: clean(htmlData.reviewCount)
//     };

//     // Логи с цветами
//     console.log(`${COLORS.blue}HTML data:${COLORS.reset}`, htmlData);
//     console.log(`${COLORS.green}XHR data:${COLORS.reset}`, {
//       price: xhrData.price,
//       priceOld: xhrData.priceOld,
//       rating: xhrData.rating,
//       reviewCount: xhrData.reviewCount,
//       url: xhrData.url
//     });

//     console.log(`
// price=${finalData.price ?? 'null'}
// priceOld=${finalData.priceOld ?? 'null'}
// rating=${finalData.rating ?? 'null'}
// reviewCount=${finalData.reviewCount ?? 'null'}
// `);

// // Скрываем ненужные элементы перед скриншотом
// await page.evaluate(() => {
//   const selectorsToHide = [
//     'header',                        // хедер сайта
//     'div.CategorySelectorWrapper',    // верхний виджет выбора категории
//     'div.PopupWrapper'                // любые всплывающие окна
//   ];
//   selectorsToHide.forEach(sel => {
//     document.querySelectorAll(sel).forEach(el => el.style.display = 'none');
//   });
// });

// // Скриншот всей страницы
// await page.screenshot({ path: 'screenshot.jpg', fullPage: true });
// console.log('Screenshot saved without top widgets');

//   } finally {
//     await browser.close();
//     console.log('Done');
//   }
// })();















// #!/usr/bin/env node
// import puppeteer from 'puppeteer';
// import fs from 'fs/promises';

// const delay = ms => new Promise(res => setTimeout(res, ms));

// async function saveToFile(filePath, content) {
//   try {
//     await fs.writeFile(filePath, content, 'utf-8');
//     console.log(`✅ File saved: ${filePath}`);
//   } catch (err) {
//     console.error(`❌ Failed to write file ${filePath}`, err);
//   }
// }

// // Очистка значений
// const clean = v => {
//   if (!v) return null;
//   return v.toString()
//           .replace(/\s/g, '')
//           .replace('₽', '')
//           .replace('/шт', '')
//           .replace(',', '.');
// };

// const [,, productUrl, region] = process.argv;
// if (!productUrl || !region) {
//   console.error("Usage: node puppeteerParser.js <URL> \"<Region>\"");
//   process.exit(1);
// }

// const SELECTORS = {
//   regionBtn: 'button[data-testid*="region"], div[data-testid*="region"]',
//   regionInput: 'input[type="text"], input[placeholder*="поиск"]',
//   regionOption: 'button, a, li, div[role="button"]'
// };

// // Выбор региона
// async function setRegion(page, region) {
//   try {
//     const btn = await page.$(SELECTORS.regionBtn);
//     if (!btn) return;
//     await btn.click();

//     const input = await page.$(SELECTORS.regionInput);
//     if (input) {
//       await input.type(region, { delay: 100 });
//       await page.keyboard.press('Enter');
//       await page.waitForNavigation({ waitUntil: 'networkidle2', timeout: 10000 }).catch(() => {});
//       console.log(`✅ Region selected: ${region}`);
//     }
//   } catch (e) {
//     console.log("ℹ️ Region selection skipped:", e.message);
//   }
// }

// (async () => {
//   const browser = await puppeteer.launch({ headless: true });
//   const page = await browser.newPage();
//   await page.setViewport({ width: 1200, height: 800 });

//   let xhr_price = null;
//   let xhr_priceOld = null;

//   // Перехват JSON/XHR для цен
//   page.on('response', async response => {
//     try {
//       const ct = response.headers()['content-type'] || '';
//       if (!ct.includes('application/json')) return;
//       const text = await response.text();
//       if (!text.includes('actualPrice')) return;

//       const data = JSON.parse(text);
//       const product = data?.product || data?.products?.[0] || data?.currentProduct;
//       if (product) {
//         xhr_price = product.actualPrice?.value ?? xhr_price;
//         xhr_priceOld = product.regularPrice?.value ?? xhr_priceOld;
//       }
//     } catch {}
//   });

//   try {
//     console.log(`🛒 Loading product: ${productUrl}`);
//     console.log(`🌍 Region: ${region}`);

//     await page.goto(productUrl, { waitUntil: 'networkidle2', timeout: 60000 });
//     await setRegion(page, region);

//     // Ждём XHR до 5 секунд
//     const start = Date.now();
//     while ([xhr_price, xhr_priceOld].some(v => v === null) && Date.now() - start < 5000) {
//       await delay(200);
//     }

//     // Fallback: данные из HTML
//     const htmlData = await page.evaluate(() => {
//       const getText = sel => document.querySelector(sel)?.textContent?.trim() || null;
//       const getMeta = sel => document.querySelector(sel)?.getAttribute('content') || null;

//       return {
//         html_price: getMeta('div[itemProp="offers"] meta[itemProp="price"]') || getText('.Price_price__QzA8L.Price_size_XL__MHvC1.Price_role_discount__l_tpE'),
//         html_priceOld: getMeta('div[itemProp="offers"] meta[itemProp="priceOld"]') || getText('.Price_price__QzA8L.Price_size_XS__ESEhJ.Price_role_old__r1uT1'),
//         html_rating: getMeta('section[itemProp="aggregateRating"] meta[itemProp="ratingValue"]'),
//         html_reviewCount: getMeta('section[itemProp="aggregateRating"] meta[itemProp="reviewCount"]')
//       };
//     });

//     // Финальный merge
//     const finalData = {
//       price: clean(xhr_price ?? htmlData.html_price),
//       priceOld: clean(xhr_priceOld ?? htmlData.html_priceOld),
//       rating: clean(htmlData.html_rating),
//       reviewCount: clean(htmlData.html_reviewCount)
//     };

//     const output = `
// price=${finalData.price ?? 'null'}
// priceOld=${finalData.priceOld ?? 'null'}
// rating=${finalData.rating ?? 'null'}
// reviewCount=${finalData.reviewCount ?? 'null'}
// `.trim();

//     await saveToFile('product.txt', output);
//     console.log(output);

//     // Скриншот
//     await page.waitForSelector('body', { visible: true, timeout: 5000 });
//     await page.screenshot({ path: 'screenshot.jpg', fullPage: true });
//     console.log('📸 Screenshot saved: screenshot.jpg');

//   } finally {
//     await browser.close();
//     console.log('✓ Done');
//   }
// })();










// #!/usr/bin/env node
// import puppeteer from 'puppeteer';
// import fs from 'fs/promises';

// const delay = ms => new Promise(res => setTimeout(res, ms));

// async function saveToFile(filePath, content) {
//   try {
//     await fs.writeFile(filePath, content, 'utf-8');
//     console.log(`✅ File saved: ${filePath}`);
//   } catch (err) {
//     console.error(`❌ Failed to write file ${filePath}`, err);
//   }
// }

// const clean = v => (v ? v.toString().replace(/\s/g, '').replace(',', '.') : null);

// const [,, productUrl, region] = process.argv;
// if (!productUrl || !region) {
//   console.error("Usage: node puppeteerParser.js <URL> \"<Region>\"");
//   process.exit(1);
// }

// const SELECTORS = {
//   regionBtn: 'button[data-testid*="region"], div[data-testid*="region"]',
//   regionInput: 'input[type="text"], input[placeholder*="поиск"]',
//   regionOption: 'button, a, li, div[role="button"]'
// };

// async function setRegion(page, region) {
//   try {
//     const btn = await page.$(SELECTORS.regionBtn);
//     if (!btn) return;
//     await btn.click();

//     const input = await page.$(SELECTORS.regionInput);
//     if (input) {
//       await input.type(region, { delay: 100 });
//       await page.keyboard.press('Enter');
//       await page.waitForNavigation({ waitUntil: 'networkidle2', timeout: 10000 }).catch(() => {});
//       console.log(`✅ Region selected: ${region}`);
//     }
//   } catch (e) {
//     console.log("ℹ️ Region selection skipped:", e.message);
//   }
// }

// (async () => {
//   const browser = await puppeteer.launch({ headless: true });
//   const page = await browser.newPage();
//   await page.setViewport({ width: 1200, height: 800 });

//   // Данные
//   let price = null;
//   let priceOld = null;

//   // Перехватываем XHR
//   page.on('response', async response => {
//     try {
//       const ct = response.headers()['content-type'] || '';
//       if (!ct.includes('application/json')) return;
//       const text = await response.text();
//       if (!text.includes('actualPrice')) return;
//       const data = JSON.parse(text);
//       const product = data?.product || data?.products?.[0] || data?.currentProduct;
//       if (product) {
//         price = product.actualPrice?.value ?? price;
//         priceOld = product.regularPrice?.value ?? priceOld;
//       }
//     } catch {}
//   });

//   try {
//     console.log(`🛒 Loading product: ${productUrl}`);
//     console.log(`🌍 Region: ${region}`);

//     await page.goto(productUrl, { waitUntil: 'networkidle2', timeout: 60000 });
//     await setRegion(page, region);

//     // Ждём до 5 секунд, чтобы XHR сработал
//     const start = Date.now();
//     while ([price, priceOld].some(v => v === null) && Date.now() - start < 5000) {
//       await delay(200);
//     }

//     // Fallback на HTML
//     const htmlData = await page.evaluate(() => {
//       const getText = sel => document.querySelector(sel)?.textContent?.trim() || null;
//       const getMeta = sel => document.querySelector(sel)?.getAttribute('content') || null;

//       return {
//         priceHtml: getMeta('div[itemProp="offers"] meta[itemProp="price"]') || getText('.Price_price__QzA8L.Price_size_XL__MHvC1.Price_role_discount__l_tpE'),
//         priceOldHtml: getMeta('div[itemProp="offers"] meta[itemProp="priceOld"]') || getText('.Price_price__QzA8L.Price_size_XS__ESEhJ.Price_role_old__r1uT1'),
//         rating: getMeta('section[itemProp="aggregateRating"] meta[itemProp="ratingValue"]'),
//         reviewCount: getMeta('section[itemProp="aggregateRating"] meta[itemProp="reviewCount"]')
//       };
//     });

//     const finalData = {
//       price: price ?? clean(htmlData.priceHtml),
//       priceOld: priceOld ?? clean(htmlData.priceOldHtml),
//       rating: clean(htmlData.rating),
//       reviewCount: clean(htmlData.reviewCount)
//     };

//     const output = `
// price=${finalData.price ?? 'null'}
// priceOld=${finalData.priceOld ?? 'null'}
// rating=${finalData.rating ?? 'null'}
// reviewCount=${finalData.reviewCount ?? 'null'}
// `.trim();

//     await saveToFile('product.txt', output);
//     console.log(output);

//     await page.waitForSelector('body', { visible: true });
//     await page.screenshot({ path: 'screenshot.jpg', fullPage: true });
//     console.log('📸 Screenshot saved: screenshot.jpg');

//   } finally {
//     await browser.close();
//     console.log('✓ Done');
//   }
// })();











  // {
//   "name": "vprok-parser",
//   "version": "2.0.0",
//   "type": "module",
//   "scripts": {
//     "start": "node src/index.js",
//     "parse:product": "node src/parsers/puppeteerParser.js",
//     "parse:category": "node src/parsers/apiParser.js",
//     "lint": "eslint src",
//     "format": "prettier --write src"
//   },
//   "dependencies": {
//     "axios": "^1.7.0",
//     "dotenv": "^16.3.0",
//     "puppeteer": "^24.15.0",
//     "winston": "^3.11.0"
//   },
//   "devDependencies": {
//     "eslint": "^9.0.0",
//     "prettier": "^3.0.0"
//   }
// }




// #!/usr/bin/env node
// import puppeteer from "puppeteer";
// import fs from "fs/promises";

// // Функция сохранения файла
// const saveToFile = async (filePath, content) => {
//   try {
//     await fs.writeFile(filePath, content, "utf-8");
//     console.log(`✅ File saved: ${filePath}`);
//   } catch (err) {
//     console.error(`❌ Failed to write file ${filePath}`, err);
//   }
// };

// // Получаем аргументы
// const [,, productUrl, region] = process.argv;
// if (!productUrl || !region) {
//   console.error("Использование: node puppeteer.js <URL_товара> \"<Регион>\"");
//   process.exit(1);
// }

// // Очистка числовых значений
// const clean = (v) => (v ? v.toString().replace(/\s/g, "").replace(",", ".") : "N/A");

// // Селекторы для выбора региона
// const SELECTORS = {
//   regionPopup: '[data-testid="region-popup"]',
//   regionInput: '[data-testid="region-input"]',
//   regionOption: '[data-testid="region-suggest-item"]'
// };

// // Функция выбора региона
// async function setRegion(page, region) {
//   try {
//     await page.waitForSelector(SELECTORS.regionPopup, { visible: true, timeout: 5000 });
//     console.log("📍 Выбираем регион...");
//     await page.click(SELECTORS.regionPopup);

//     await page.waitForSelector(SELECTORS.regionInput, { visible: true, timeout: 5000 });
//     await page.type(SELECTORS.regionInput, region, { delay: 100 });

//     const options = await page.$$(SELECTORS.regionOption);
//     if (options.length > 0) {
//       await options[0].click();
//       await page.waitForNavigation({ waitUntil: "networkidle2", timeout: 10000 }).catch(() => {});
//       console.log(`✅ Регион выбран: ${region}`);
//     } else {
//       console.log(`⚠️ Не удалось выбрать регион: ${region}`);
//     }
//   } catch {
//     console.log("ℹ️ Регион уже установлен или окно не появилось.");
//   }
// }

// // Функция умного retry для динамически появляющихся элементов
// async function getTextWithRetry(page, selector, timeout = 10000, interval = 200) {
//   const start = Date.now();
//   while (Date.now() - start < timeout) {
//     const element = await page.$(selector);
//     if (element) {
//       const text = await page.evaluate(el => el.textContent.trim(), element);
//       if (text) return text;
//     }
//     await new Promise(res => setTimeout(res, interval));
//   }
//   return "N/A";
// }

// (async () => {
//   const browser = await puppeteer.launch({ headless: true });
//   const page = await browser.newPage();
//   await page.setViewport({ width: 1200, height: 800 });

//   // Объект для хранения данных
//   let productData = { price: null, priceOld: null, rating: "N/A", reviewCount: "N/A" };

//   // Перехват JSON-ответов для цен
//   page.on("response", async (response) => {
//     try {
//       const ct = response.headers()["content-type"] || "";
//       if (!ct.includes("application/json")) return;
//       const text = await response.text();
//       if (!text.includes("actualPrice")) return;
//       const data = JSON.parse(text);
//       const product = data?.product || data?.products?.[0] || data?.currentProduct;
//       if (product) {
//         productData.price = product.actualPrice?.value ?? productData.price;
//         productData.priceOld = product.regularPrice?.value ?? productData.priceOld;
//       }
//     } catch {}
//   });

//   try {
//     console.log(`🛒 Загружаем товар: ${productUrl}`);
//     console.log(`🌍 Регион: ${region}`);

//     await page.goto(productUrl, { waitUntil: "networkidle2", timeout: 60000 });
//     await setRegion(page, region);

//     // Ждем данные через XHR (до 10 секунд)
//     const start = Date.now();
//     while ([productData.price, productData.priceOld].some(v => v === null)) {
//       if (Date.now() - start > 10000) break;
//       await new Promise(res => setTimeout(res, 200));
//     }

//     // Fallback через HTML для цен
//     const fallback = await page.evaluate(() => {
//       const query = sel => document.querySelector(sel)?.textContent?.trim() || null;
//       return {
//         price: query('.Price_price__QzA8L.Price_size_XL__MHvC1.Price_role_discount__l_tpE'),
//         priceOld: query('.Price_price__QzA8L.Price_size_XS__ESEhJ.Price_role_old__r1uT1')
//       };
//     });
//     productData.price = productData.price ?? fallback.price;
//     productData.priceOld = productData.priceOld ?? fallback.priceOld;

//     // Умный retry для рейтинга и количества отзывов
//     productData.rating = await getTextWithRetry(page, '[data-testid="product-rating-stars"] span', 10000);
//     productData.reviewCount = await getTextWithRetry(page, '[data-testid="product-review-count"]', 10000);

//     const output = `price=${clean(productData.price)}
// priceOld=${clean(productData.priceOld)}
// rating=${clean(productData.rating)}
// reviewCount=${clean(productData.reviewCount)}
// `;

//     await saveToFile("product.txt", output);
//     console.log(output);

//     // Скриншот страницы
//     await page.waitForSelector("body", { visible: true });
//     await page.screenshot({ path: "screenshot.jpg", fullPage: true });
//     console.log("📸 Скриншот сохранён: screenshot.jpg");

//   } finally {
//     await browser.close();
//   }
// })();













// import puppeteer from "puppeteer";
// import fs from "fs/promises";

// const [,, productUrl] = process.argv;

// if (!productUrl) {
//   console.log("Использование: node src/parsers/vprokUniversalParser.js <url>");
//   process.exit(1);
// }

// // Вспомогательная функция для очистки значений
// const clean = (v) => {
//   if (!v) return "N/A";
//   return v.toString().replace(/[^\d.,]/g, "").replace(",", ".") || "N/A";
// };

// (async () => {
//   console.log(`🛒 Загружаем товар: ${productUrl}`);

//   const browser = await puppeteer.launch({
//     headless: process.env.PUPPETEER_HEADLESS !== "false",
//     defaultViewport: null
//   });

//   const page = await browser.newPage();
//   let productData = null;
//   let foundBy = "none";

//   // ===== 1️⃣ Ловим все JSON-ответы (XHR / Fetch / GraphQL)
//   page.on("response", async (response) => {
//     try {
//       const contentType = response.headers()["content-type"] || "";
//       if (contentType.includes("application/json")) {
//         const url = response.url();
//         const text = await response.text();

//         // Для отладки можно включить логирование XHR
//         // console.log("📡 XHR:", url);

//         if (text.includes("price") || text.includes("rating")) {
//           const data = JSON.parse(text);
//           if (!productData) {
//             productData = data;
//             foundBy = "xhr";
//           }
//         }
//       }
//     } catch {}
//   });

//   // ===== 2️⃣ Загружаем страницу
//   await page.goto(productUrl, { waitUntil: "networkidle2", timeout: 60000 });

//   // Ожидаем динамические XHR-запросы
//   await page.waitForTimeout(6000);

//   // Проверяем, не 404 ли страница
//   const title = await page.title();
//   const html = await page.content();
//   if (title.includes("404") || html.includes("товар не найден")) {
//     console.log("❌ Товар не найден или недоступен.");
//     await browser.close();
//     return;
//   }

//   // ===== 3️⃣ Если XHR не найден — ищем встроенный JSON
//   if (!productData) {
//     try {
//       const inlineJson = await page.$$eval("script[type='application/json']", els =>
//         els.map(el => el.textContent).find(t => t.includes("price"))
//       );
//       if (inlineJson) {
//         productData = JSON.parse(inlineJson);
//         foundBy = "inline script";
//       }
//     } catch {}
//   }

//   // ===== 4️⃣ Если JSON не найден — fallback на HTML
//   let result = {
//     price: "N/A",
//     priceOld: "N/A",
//     rating: "N/A",
//     reviewCount: "N/A"
//   };

//   if (productData) {
//     // Пробуем найти нужные поля в глубине JSON
//     const text = JSON.stringify(productData);
//     const matchActual = text.match(/"actual"[:\s]*"?([\d.,]+)"?/);
//     const matchRegular = text.match(/"regular"[:\s]*"?([\d.,]+)"?/);
//     const matchPrice = text.match(/"price"[:\s]*"?([\d.,]+)"?/);
//     const matchRating = text.match(/"rating"[:\s]*"?([\d.,]+)"?/);
//     const matchReview = text.match(/"reviewsCount"[:\s]*"?(\d+)"?/);

//     result = {
//       price: clean(matchPrice?.[1] ?? matchActual?.[1]),
//       priceOld: clean(matchRegular?.[1]),
//       rating: clean(matchRating?.[1]),
//       reviewCount: clean(matchReview?.[1])
//     };
//   } else {
//     console.log("⚙️ XHR не найден, пробуем парсить HTML…");
//     result = await page.evaluate(() => ({
//       price:
//         document.querySelector('[data-testid="price__value"]')?.textContent?.trim() ?? "N/A",
//       priceOld:
//         document.querySelector('[data-testid="price__old-value"]')?.textContent?.trim() ?? "N/A",
//       rating:
//         document.querySelector('[data-testid="product-rating-stars"] span')?.textContent?.trim() ??
//         "N/A",
//       reviewCount:
//         document.querySelector('[data-testid="product-review-count"]')?.textContent?.trim() ??
//         "N/A"
//     }));
//     foundBy = "html";
//   }

//   // ===== 5️⃣ Формируем результат и сохраняем
//   const output = `price=${result.price}\npriceOld=${result.priceOld}\nrating=${result.rating}\nreviewCount=${result.reviewCount}\n`;

//   await fs.writeFile("product.txt", output, "utf-8");

//   console.log(`✅ Метод: ${foundBy}`);
//   console.log("📄 Результат сохранён в product.txt");

//   await browser.close();
// })();





















// import puppeteer from "puppeteer";
// import dotenv from "dotenv";
// import logger from "../config/logger.js";
// import { saveToFile } from "../utils/file.js";

// dotenv.config();

// const [,, productUrl, region] = process.argv;

// if(!productUrl || !region){
//     logger.error("Using: npm run parse:product <url> <region>");
//     process.exit(1);
// }



// const SELECTORS = {
//     regionPopup: '[data-testid="region-popup"]',
//     regionInput: '[data-testid="region-input"]',
//     price: ".Price_price__QzA8L.Price_size_XL__MHvC1.Price_role_discount__l_tpE",
//     priceOld: ".Price_price__QzA8L.Price_size_XS__ESEhJ.Price_role_old__r1uT1",
//     rating: ".ActionsRow_stars__EKt42",
//     reviewCount: ".ActionsRow_reviews__AfSj_"
// };

// async function clickIfExists(page, selector, timeout = 5000) {
//     try {
//         await page.waitForSelector(selector, { timeout });
//         await page.click(selector);
//         return true;
//     } catch {
//         return false;
//     }
// }

// (async () => {
//     logger.info(`Starting Puppeteer for: ${productUrl}`);

//     let browser;

//     try{
//         browser = await puppeteer.launch({
//             headless: process.env.PUPPETEER_HEADLESS === "true"
//     });

//     const page = await browser.newPage();

//     await page.goto(productUrl, { waitUntil: "networkidle2", timeout: 30000 });

//     const regionPopupExists = await clickIfExists(page, SELECTORS.regionPopup);
//     if (regionPopupExists) {
//         await page.type(SELECTORS.regionInput, region);
//         await page.keyboard.press("Enter");

//         try {
//             await page.waitForNavigation({ waitUntil: "networkidle2", timeout: 5000 });
//         } catch {
//             logger.warn("Navigation after setting region did not happen within timeout");
//         }

//         logger.info(`Region set: ${region}`);
        
//     } else {
//         logger.info("Region already set or not required");
//     }

//     await page.screenshot({ path: "screenshot.jpg", fullPage: true });
//     logger.info("Screenshot saved: screenshot.jpg");

//     const product = await page.evaluate((selectors) => ({
//             price: document.querySelector(selectors.price)?.textContent?.trim() || null,
//             priceOld: document.querySelector(selectors.priceOld)?.textContent?.trim() || null,
//             rating: document.querySelector(selectors.rating)?.textContent?.trim() || null,
//             reviewCount: document.querySelector(selectors.reviewCount)?.textContent?.trim() || null
//         }), SELECTORS);

//     const text = Object.entries(product)
//       .map(([k, v]) => `${k}=${v ?? "N/A"}`)
//       .join("\n");

//     await saveToFile("product.txt", text);

//     }catch (err) {
//         logger.error("Failed to parse product page", err);
//     }finally {
//         if (browser) await browser.close();
//         logger.info("Browser closed");
//     }
// })();