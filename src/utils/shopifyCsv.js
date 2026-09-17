// Build a Shopify product-import CSV from history runs.
//
// The format below was reverse-engineered from T.Mangharam's own working import
// file (30 products / 255 rows) and matches it exactly:
//
//   * Every product occupies N rows sharing one Handle.
//   * VARIANT rows come first (1 for a plain product, V for a colour-variant
//     product). Each carries its SKU, the variant fields, and that SKU's FIRST
//     image (the "Tray" shot).
//   * IMAGE-ONLY rows follow, carrying just Handle/Title/Image Src/Position/Alt
//     for the remaining images, grouped by variant in order.
//   * Product-level fields (Body, Tags, SEO, Vendor…) appear on ROW 1 ONLY.
//   * Image Position = variantIndex * imagesPerVariant + imageIndex + 1, so each
//     variant owns a contiguous block (1-5, 6-10, …).
//
// Shopify downloads Image Src at import and re-hosts it on its own CDN, so the
// R2 URLs here are only a pickup point.

import { csvCell, triggerDownload, plainPreview } from "./captionCsv";

// Verbatim header from the reference file — order matters to Shopify.
export const SHOPIFY_HEADER = [
  "Handle", "Title", "Body (HTML)", "Vendor", "Product Category", "Type", "Tags", "Published",
  "Option1 Name", "Option1 Value", "Option1 Linked To",
  "Option2 Name", "Option2 Value", "Option2 Linked To",
  "Option3 Name", "Option3 Value", "Option3 Linked To",
  "Variant SKU", "Variant Grams", "Variant Inventory Tracker", "Variant Inventory Qty",
  "Variant Inventory Policy", "Variant Fulfillment Service", "Variant Price",
  "Variant Compare At Price", "Variant Requires Shipping", "Variant Taxable",
  "Unit Price Total Measure", "Unit Price Total Measure Unit", "Unit Price Base Measure",
  "Unit Price Base Measure Unit", "Variant Barcode",
  "Image Src", "Image Position", "Image Alt Text", "Gift Card", "SEO Title", "SEO Description",
  "Google Shopping / Google Product Category", "Google Shopping / Gender",
  "Google Shopping / Age Group", "Google Shopping / MPN", "Google Shopping / Condition",
  "Google Shopping / Custom Product", "Google Shopping / Custom Label 0",
  "Google Shopping / Custom Label 1", "Google Shopping / Custom Label 2",
  "Google Shopping / Custom Label 3", "Google Shopping / Custom Label 4",
  "Color (product.metafields.custom.color)", "Craft (product.metafields.custom.craft)",
  "Fabric (product.metafields.custom.fabric)", "Pattern (product.metafields.custom.pattern)",
  "Workmanship (product.metafields.custom.workmanship)",
  "Google: Custom Product (product.metafields.mm-google-shopping.custom_product)",
  "Product rating count (product.metafields.reviews.rating_count)",
  "Color (product.metafields.shopify.color-pattern)",
  "Complementary products (product.metafields.shopify--discovery--product_recommendation.complementary_products)",
  "Related products (product.metafields.shopify--discovery--product_recommendation.related_products)",
  "Related products settings (product.metafields.shopify--discovery--product_recommendation.related_products_display)",
  "Search product boosts (product.metafields.shopify--discovery--product_search_boost.queries)",
  "Variant Image", "Variant Weight Unit", "Variant Tax Code", "Cost per item",
  "Included / India", "Price / India", "Compare At Price / India",
  "Included / International", "Price / International", "Compare At Price / International",
  "Status",
];

// Fixed values used on every product / variant row (mined from the reference file).
export const DEFAULTS = {
  vendor: "T Mangharam",
  productCategory: "Arts & Entertainment > Hobbies & Creative Arts > Arts & Crafts > Art & Crafting Materials > Textiles > Fabric",
  type: "Fabric Lengths",
  published: "TRUE",
  grams: "100",
  inventoryTracker: "shopify",
  inventoryQty: "20",
  inventoryPolicy: "deny",
  fulfillmentService: "manual",
  requiresShipping: "TRUE",
  taxable: "TRUE",
  giftCard: "FALSE",
  weightUnit: "g",
  status: "draft",
  seoDescriptionMax: 320,
};

const META_ID = new Set(["__original__", "__detail__"]);
const FLAT_ID = "__flat__";

// Styled images in stored order, with the flat swatch last (matches the
// reference file's Tray → Swirl → folds → saree_drape → Flat-fabric ordering).
export function orderedImages(record) {
  const usable = (record.images || []).filter(im => im.url && !META_ID.has(im.templateId));
  const flat = usable.filter(im => im.templateId === FLAT_ID);
  const styled = usable.filter(im => im.templateId !== FLAT_ID);
  return [...styled, ...flat];
}

export function handleFor(sku) {
  return `fabric-lengths-${String(sku || "").trim().toLowerCase()}`;
}

// Shopify requires option values to be unique within a product; the reference
// file disambiguates a repeated colour as "Green" / "Green 1".
export function uniqueColours(values) {
  const seen = new Map();
  return (values || []).map(v => {
    const base = (v == null ? "" : String(v)).trim();
    const key = base.toLowerCase();
    const n = seen.get(key) || 0;
    seen.set(key, n + 1);
    return n === 0 ? base : `${base} ${n}`;
  });
}

// The store lists the price for 0.5 m, but prices are entered per metre — so the
// CSV carries half the entered value (200 entered -> 100 in the sheet).
export function halfPrice(price) {
  const n = parseFloat(String(price == null ? "" : price).replace(/[^0-9.]/g, ""));
  if (!Number.isFinite(n)) return "";
  const half = n / 2;
  return String(Number(half.toFixed(2)));   // trims 22.50 -> 22.5, 100.00 -> 100
}

// Craft metafield is one of exactly two values: Embroidery when the product is
// tagged as embroidered, otherwise Printed.
export function craftFor(tags) {
  return (tags || []).some(t => /embroider/i.test(String(t))) ? "Embroidery" : "Printed";
}

// Every distinct colour in the product, in variant order (case-insensitive), using
// the colours as typed — not the " 1"-suffixed Option1 values, which exist only to
// keep Shopify happy about duplicate option names.
export function distinctColours(variants) {
  const seen = new Set(), out = [];
  for (const v of (variants || [])) {
    const c = ((v && v.colour) || "").trim();
    if (!c) continue;
    const k = c.toLowerCase();
    if (!seen.has(k)) { seen.add(k); out.push(c); }
  }
  return out;
}

// The product row carries the tags for the whole product, so every variant colour
// has to appear there — a shopper filtering by "Blue" must find the red lead SKU
// if one of its variants is blue.
export function withVariantColours(tags, colours) {
  const out = [], seen = new Set();
  for (const t of (tags || []).concat(colours || [])) {
    const v = (t == null ? "" : String(t)).trim();
    if (!v) continue;
    const k = v.toLowerCase();
    if (!seen.has(k)) { seen.add(k); out.push(v); }
  }
  return out;
}

function altFor(image, title, sku) {
  const own = (image.alt || "").trim();
  return own || `${title} - ${sku} - ${image.templateLabel || ""}`;
}

// Clean, Shopify-friendly image filename: EC17010_Tray
export function imageFileName(sku, templateLabel) {
  const t = String(templateLabel || "image").replace(/[^A-Za-z0-9]+/g, "-").replace(/^-|-$/g, "");
  return `${String(sku || "").trim()}_${t}`;
}

// products: [{
//   title, price, bodyHtml, tags[], variants: [
//     { sku, colour, record, material, adjective, images: [{url, templateLabel, alt}] }
//   ]
// }]
export function buildShopifyCsv(products) {
  const idx = {};
  SHOPIFY_HEADER.forEach((h, i) => { idx[h] = i; });
  const blank = () => new Array(SHOPIFY_HEADER.length).fill("");
  const lines = [SHOPIFY_HEADER.map(csvCell).join(",")];

  for (const p of (products || [])) {
    const variants = p.variants || [];
    if (!variants.length) continue;
    const isVariant = variants.length > 1;
    const handle = handleFor(variants[0].sku);
    const title = p.title || "";
    const colours = uniqueColours(variants.map(v => v.colour));
    const perVariant = Math.max(...variants.map(v => (v.images || []).length), 1);
    const price = halfPrice(p.price);          // sheet carries the 0.5 m price
    const craft = craftFor(p.tags);
    const allColours = distinctColours(variants);
    const rows = [];

    // --- variant rows (each carries that SKU's first image) ---
    variants.forEach((v, vi) => {
      const r = blank();
      const imgs = v.images || [];
      const first = imgs[0];
      r[idx["Handle"]] = handle;
      r[idx["Title"]] = title;
      if (isVariant) {
        r[idx["Option1 Name"]] = "Color";
        r[idx["Option1 Value"]] = colours[vi];
      }
      r[idx["Variant SKU"]] = v.sku;
      r[idx["Variant Grams"]] = DEFAULTS.grams;
      r[idx["Variant Inventory Tracker"]] = DEFAULTS.inventoryTracker;
      r[idx["Variant Inventory Qty"]] = DEFAULTS.inventoryQty;
      r[idx["Variant Inventory Policy"]] = DEFAULTS.inventoryPolicy;
      r[idx["Variant Fulfillment Service"]] = DEFAULTS.fulfillmentService;
      r[idx["Variant Price"]] = price;
      r[idx["Variant Requires Shipping"]] = DEFAULTS.requiresShipping;
      r[idx["Variant Taxable"]] = DEFAULTS.taxable;
      r[idx["Gift Card"]] = DEFAULTS.giftCard;
      r[idx["Variant Weight Unit"]] = DEFAULTS.weightUnit;
      r[idx["Craft (product.metafields.custom.craft)"]] = craft;
      if (first) {
        r[idx["Image Src"]] = first.url;
        r[idx["Image Position"]] = String(vi * perVariant + 1);
        r[idx["Image Alt Text"]] = altFor(first, title, v.sku);
        r[idx["Variant Image"]] = first.url;
      }
      // Metafields filled from our own data (the reference file hardcoded these).
      if (v.material) r[idx["Fabric (product.metafields.custom.fabric)"]] = v.material;
      if (v.adjective) r[idx["Pattern (product.metafields.custom.pattern)"]] = v.adjective;
      r[idx["Included / India"]] = "TRUE";
      r[idx["Price / India"]] = price;
      r[idx["Status"]] = DEFAULTS.status;
      rows.push(r);
    });

    // --- product-level fields: row 1 only ---
    const head = rows[0];
    head[idx["Body (HTML)"]] = p.bodyHtml || "";
    head[idx["Vendor"]] = DEFAULTS.vendor;
    head[idx["Product Category"]] = DEFAULTS.productCategory;
    head[idx["Type"]] = DEFAULTS.type;
    head[idx["Tags"]] = withVariantColours(p.tags, allColours).join(", ");
    head[idx["Published"]] = DEFAULTS.published;
    head[idx["SEO Title"]] = title;
    head[idx["SEO Description"]] = plainPreview(p.bodyHtml || "", DEFAULTS.seoDescriptionMax);
    if (allColours.length) head[idx["Color (product.metafields.custom.color)"]] = allColours.join("\n");

    // --- image-only rows for every remaining image ---
    variants.forEach((v, vi) => {
      (v.images || []).slice(1).forEach((im, j) => {
        const r = blank();
        r[idx["Handle"]] = handle;
        r[idx["Title"]] = title;
        r[idx["Image Src"]] = im.url;
        r[idx["Image Position"]] = String(vi * perVariant + j + 2);
        r[idx["Image Alt Text"]] = altFor(im, title, v.sku);
        rows.push(r);
      });
    });

    rows.forEach(r => lines.push(r.map(csvCell).join(",")));
  }

  return lines.join("\r\n");
}

function stamp() {
  return new Date().toISOString().replace(/[:.]/g, "-").slice(0, 19);
}

export function downloadShopifyCsv(products, filename) {
  const csv = buildShopifyCsv(products);
  // Leading BOM so Excel/Sheets read UTF-8 correctly.
  triggerDownload(new Blob(["﻿" + csv], { type: "text/csv;charset=utf-8" }),
    filename || `shopify-import-${stamp()}.csv`);
}

// Turn a history record into the default single-product shape for the export UI.
export function productFromRecord(record) {
  const f = record.facts || {};
  const cap = record.caption || {};
  return {
    title: cap.title || record.fabricName || "",
    price: "",
    bodyHtml: cap.description || "",
    tags: cap.tags || [],
    variants: [{
      sku: record.fabricName || "",
      colour: f.colour || "",
      material: f.material || "",
      adjective: f.adjective || "",
      images: orderedImages(record),
    }],
  };
}

// Shared title for a colour-variant group: "{Adjective} {Material} Fabric"
// (no colour, no SKU) — matches the reference file's variant products.
export function groupTitle(variants) {
  const v = variants.find(x => x.adjective || x.material) || variants[0] || {};
  const parts = [v.adjective, v.material].map(s => (s || "").trim()).filter(Boolean);
  return parts.length ? `${parts.join(" ")} Fabric` : "Fabric";
}
