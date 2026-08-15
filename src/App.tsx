import { useEffect, useMemo, useRef, useState } from "react";
import type { Session } from "@supabase/supabase-js";
import { isConfigured, supabase } from "./supabase";
import { seedProducts } from "./catalog";
import { downloadInboundTemplate, downloadStocktakeWorkbook, parseInboundWorkbook, parseStocktakeWorkbook } from "./excel";
import "./permissions.css";

type InventoryItem = {
  id: string; category: string; subcategory: string; brand: string; flavor: string; name: string;
  spec: string; unit: string; pack_size: number; current_qty: number;
  low_stock_level: number; stocktake_date: string | null; counted_by_email: string | null;
};
type Activity = {
  id: number; kind: string; product_id: string; product_name: string; quantity: number;
  entered_quantity: number; entered_unit: string; pack_size: number; actor_id: string;
  actor: string; happened_at: string; is_corrected: boolean; original_quantity: number | null;
  original_product_name: string | null; corrected_by_email: string | null; corrected_at: string | null;
  source: string; order_number: string | null; is_voided: boolean; voided_by_email: string | null;
  voided_at: string | null; void_reason: string | null;
};
type WorkspaceRole = "owner" | "admin" | "member" | "viewer";
type Workspace = { id: string; name: string; role: WorkspaceRole };
type WorkspaceMember = { user_id: string; email: string; role: WorkspaceRole };
type Tab = "count" | "stock" | "inbound" | "activity";
type UnitMode = "package" | "base";
type StockDisplayMode = "mixed" | "base" | "package";
type ProductDraft = {
  category: string; subcategory: string; brand: string; flavor: string; name: string; spec: string;
  unit: string; pack_size: number; low_stock_level: number;
};
type PdfLine = { productId: string; pieces: number | ""; unitMode: UnitMode; draft?: ProductDraft };
type RecognizableProduct = Pick<InventoryItem, "id" | "category" | "subcategory" | "brand" | "flavor" | "name" | "spec" | "unit" | "pack_size">;
type NewProduct = {
  category: string; subcategory: string; brand: string; flavor: string; name: string; spec: string;
  unit: string; packSize: string; initialPieces: string; lowStockLevel: string;
};
type OcrProgress = { label: string; percent: number };
type ExcelInboundLine = { rowNumber: number; productId: string; quantity: number | ""; unitMode: UnitMode; confidence: "matched" | "suggested" | "new"; original: ProductDraft; draft?: ProductDraft };
type ExcelStocktakeLine = { rowNumber: number; productId: string; packageQuantity: number | ""; looseQuantity: number | ""; quantity: number; expectedQty: number; conflictQty?: number };
type ExcelReview =
  | { kind: "inbound"; filename: string; orderNumber: string; lines: ExcelInboundLine[] }
  | { kind: "stocktake"; filename: string; exportedAt: string; lines: ExcelStocktakeLine[] };

const today = () => new Date().toLocaleDateString("en-CA", { timeZone: "Asia/Hong_Kong" });
const publisherId = import.meta.env.VITE_ADSENSE_PUBLISHER_ID ?? "";
const appVersion = "2026.08.15.19";
const roleLabel = (role: WorkspaceRole) => role === "owner" ? "擁有人" : role === "admin" ? "管理員" : role === "viewer" ? "只供查看" : "一般成員";
const stockDisplay = (item: InventoryItem, mode: StockDisplayMode) => {
  if (mode === "base" || item.pack_size < 1) return { value: String(item.current_qty), unit: item.unit };
  if (mode === "package") return { value: new Intl.NumberFormat("zh-HK", { maximumFractionDigits: 2 }).format(item.current_qty / item.pack_size), unit: "箱／包" };
  const packages = Math.floor(item.current_qty / item.pack_size);
  const loose = item.current_qty % item.pack_size;
  if (!packages) return { value: String(loose), unit: item.unit };
  if (!loose) return { value: String(packages), unit: "箱／包" };
  return { value: `${packages} 箱／包 + ${loose}`, unit: item.unit };
};

function useLatestAppVersion() {
  useEffect(() => {
    let active = true;
    const check = async () => {
      try {
        const response = await fetch(`${import.meta.env.BASE_URL}version.json?t=${Date.now()}`, { cache: "no-store" });
        const latest = await response.json() as { version?: string };
        if (!active || !latest.version || latest.version === appVersion) return;
        const url = new URL(location.href);
        if (url.searchParams.get("appv") === latest.version) return;
        url.searchParams.set("appv", latest.version);
        location.replace(url.toString());
      } catch { /* Offline use keeps the currently loaded version. */ }
    };
    check();
    const onVisible = () => { if (document.visibilityState === "visible") check(); };
    document.addEventListener("visibilitychange", onVisible);
    return () => { active = false; document.removeEventListener("visibilitychange", onVisible); };
  }, []);
}

function useAdSense() {
  useEffect(() => {
    if (!/^ca-pub-\d{16}$/.test(publisherId) || document.querySelector("script[data-stockcheck-adsense]")) return;
    const script = document.createElement("script");
    script.async = true;
    script.crossOrigin = "anonymous";
    script.dataset.stockcheckAdsense = "true";
    script.dataset.overlays = "collapsed-bottom";
    script.src = `https://pagead2.googlesyndication.com/pagead/js/adsbygoogle.js?client=${publisherId}`;
    document.head.appendChild(script);
    document.body.classList.add("adsense-active");
  }, []);
}

export function App() {
  const [session, setSession] = useState<Session | null>(null);
  const [checking, setChecking] = useState(true);
  useAdSense();
  useLatestAppVersion();

  useEffect(() => {
    supabase.auth.getSession().then(({ data }) => { setSession(data.session); setChecking(false); });
    const { data } = supabase.auth.onAuthStateChange((_event, next) => setSession(next));
    return () => data.subscription.unsubscribe();
  }, []);

  if (checking) return <main className="center-screen"><div className="spinner" /><p>連接共享庫存…</p></main>;
  if (!isConfigured) return <SetupNotice />;
  if (!session) return <PublicHome />;
  return <WorkspaceGate session={session} />;
}

function SetupNotice() {
  return <main className="public-shell"><section className="hero-card"><div className="app-mark">倉</div><p className="eyebrow">等待連接</p><h1>倉點 <span>Stockcheck</span></h1><p>網站介面已準備好，完成 Supabase Project 連接後即可開始多人共用。</p><div className="status-note">管理員設定中，毋須使用者輸入任何技術資料。</div></section></main>;
}

function PublicHome() {
  const [email, setEmail] = useState("");
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState("");
  const [privacy, setPrivacy] = useState(false);
  const [cooldown, setCooldown] = useState(0);

  useEffect(() => {
    if (!cooldown) return;
    const timer = window.setTimeout(() => setCooldown((value) => Math.max(0, value - 1)), 1000);
    return () => window.clearTimeout(timer);
  }, [cooldown]);

  const signIn = async () => {
    if (!email.includes("@")) return setMessage("請輸入正確電郵地址");
    if (cooldown) return;
    setBusy(true);
    const redirectTo = `${location.origin}${import.meta.env.BASE_URL}`;
    const { error } = await supabase.auth.signInWithOtp({ email, options: { shouldCreateUser: true, emailRedirectTo: redirectTo } });
    setBusy(false);
    if (error) {
      console.error("Magic link request failed", { code: error.code, status: error.status });
      if (error.status === 429 || error.code === "over_email_send_rate_limit") {
        setCooldown(60);
        setMessage("登入電郵已達 Supabase 發送上限。請勿再連續按，約一小時後再試。");
      } else {
        setMessage(`暫時未能寄出登入連結${error.code ? `（${error.code}）` : ""}，請稍後再試。`);
      }
      return;
    }
    setCooldown(60);
    setMessage("登入連結已寄出，請檢查電郵；60 秒內毋須再次發送。");
  };

  return <main className="public-shell">
    <section className="hero-card">
      <div className="app-mark">倉</div><p className="eyebrow">手機共享庫存</p>
      <h1>倉點 <span>Stockcheck</span></h1>
      <p>每間店舖有獨立庫存，邀請同事後即可多人同步盤點；其他店舖無法查看你嘅資料。</p>
      <div className="feature-grid"><span>✓ 每日 Stock Take</span><span>✓ 新產品及入貨</span><span>✓ PDF／圖片本機辨認</span><span>✓ 操作記錄</span></div>
      <label className="login-field">登入／開設帳戶<input type="email" inputMode="email" value={email} onChange={(e) => setEmail(e.target.value)} placeholder="name@example.com" /></label>
      <button className="primary-button" onClick={signIn} disabled={busy || cooldown > 0}>{busy ? "寄出中…" : cooldown ? `請等 ${cooldown} 秒` : "寄出安全登入連結"}</button>
      {message && <p className="form-message" aria-live="polite">{message}</p>}
      <button className="text-button" onClick={() => setPrivacy(true)}>私隱政策</button>
    </section>
    {privacy && <PrivacyDialog close={() => setPrivacy(false)} />}
  </main>;
}

function PrivacyDialog({ close }: { close: () => void }) {
  return <div className="modal-backdrop"><section className="modal privacy-modal"><div className="modal-head"><div><p className="eyebrow">Privacy</p><h2>私隱政策</h2></div><button onClick={close}>關閉</button></div><p>倉點只儲存獲授權使用者的電郵、產品資料、盤點與入貨記錄。PDF 及圖片會在使用者裝置內進行文字辨認，原檔不會上傳到 Stockcheck Database。</p><p>網站使用 Supabase 提供登入及共享資料庫，並可能使用 Google AdSense 顯示廣告。Google 可能按其政策使用 Cookie 或類似技術提供及量度廣告。</p><p>如要查閱或刪除帳戶資料，請聯絡網站管理員。使用本網站代表同意上述資料處理。</p></section></div>;
}

const normalizeOcr = (value: string) => value.normalize("NFKC").toLowerCase().replace(/[^\p{L}\p{N}]/gu, "");
const excelUnitMode = (value: string): UnitMode => /箱|包|pack|box|carton/i.test(value) ? "package" : "base";
function matchExcelProduct(row: { brand: string; flavor: string; name: string; spec: string }, items: InventoryItem[]) {
  const wanted = { brand: normalizeOcr(row.brand), flavor: normalizeOcr(row.flavor), name: normalizeOcr(row.name), spec: normalizeOcr(row.spec) };
  const ranked = items.map((item) => {
    const actual = { brand: normalizeOcr(item.brand), flavor: normalizeOcr(item.flavor), name: normalizeOcr(item.name), spec: normalizeOcr(item.spec) };
    let score = 0;
    if (wanted.brand && actual.brand === wanted.brand) score += 25;
    else if (wanted.brand && (actual.brand.includes(wanted.brand) || wanted.brand.includes(actual.brand))) score += 12;
    if (wanted.flavor && actual.flavor === wanted.flavor) score += 25;
    else if (wanted.flavor && (actual.flavor.includes(wanted.flavor) || wanted.flavor.includes(actual.flavor))) score += 12;
    if (wanted.name && actual.name === wanted.name) score += 35;
    else if (wanted.name && (actual.name.includes(wanted.name) || wanted.name.includes(actual.name))) score += 20;
    if (wanted.spec && actual.spec === wanted.spec) score += 15;
    else if (wanted.spec && (actual.spec.includes(wanted.spec) || wanted.spec.includes(actual.spec))) score += 7;
    return { item, score };
  }).sort((a, b) => b.score - a.score);
  return ranked[0]?.score >= 45 ? ranked[0] : null;
}
const catalogItems: RecognizableProduct[] = seedProducts.map((item) => ({
  id: `catalog:${item.id}`, category: item.category, subcategory: "未分類", brand: item.brand, flavor: item.flavor,
  name: item.name, spec: item.spec, unit: item.unit, pack_size: item.packSize,
}));
const productIdentity = (item: Pick<RecognizableProduct, "brand" | "flavor" | "name" | "spec">) =>
  [item.brand, item.flavor, item.name, item.spec].map(normalizeOcr).join("|");

function recognitionProducts(items: InventoryItem[]) {
  const existing = new Set(items.map(productIdentity));
  return [...items, ...catalogItems.filter((item) => !existing.has(productIdentity(item)))];
}

function recognitionAliases(item: RecognizableProduct) {
  const aliases = [item.brand, item.flavor, item.name, item.spec];
  const brand = item.brand.toLowerCase(); const flavor = item.flavor;
  if (brand.includes("lay")) aliases.push(flavor.includes("洋蔥") ? "sour cream onion" : flavor.includes("原味") ? "classic potato chips" : "lay's");
  if (brand.includes("pocky")) aliases.push("pocky", "固力果");
  if (brand.includes("monster")) aliases.push(...(flavor.includes("無糖") ? ["超越無糖 白色", "超越", "白色", "無糖"] : ["碳酸能量飲料 黑色", "黑色"]));
  if (brand.includes("edo pack")) aliases.push(...(flavor.includes("士多啤梨") ? ["士多啤利", "士多啤利朱古力", "士多啤利朱古力批", "草莓", "strawberry"] : ["edo pack 朱古力批"]));
  if (brand.includes("coca-cola")) aliases.push(flavor.includes("無糖") ? "零系無糖可口可樂" : "可口可樂汽水");
  if (brand.includes("lotte milkis")) aliases.push(flavor.includes("無糖") ? "milkis zero 零卡" : "原味忌廉溝鮮奶");
  if (brand.includes("oreo")) aliases.push(flavor.includes("雲呢嗱") ? "雲呢嗱迷你朱古力夾心餅乾" : "朱古力味迷你朱古力夾心餅乾");
  return [...new Set(aliases.map(normalizeOcr).filter((value) => value.length >= 2))];
}

function documentMatches(text: string, items: RecognizableProduct[]) {
  const rawLines = text.split(/\r?\n/).map((line) => line.normalize("NFKC").trim()).filter(Boolean);
  const candidates: { text: string; quantity: number; lineIndex: number }[] = [];
  rawLines.forEach((line, index) => {
    const ownNumbers = [...line.matchAll(/(?:^|\s)(\d{1,3})(?=\s|$)/g)].map((match) => Number(match[1])).filter((value) => value > 0);
    if (ownNumbers.length) candidates.push({ text: line, quantity: ownNumbers.at(-1)!, lineIndex: index });
    for (let span = 2; span <= 4 && index + span <= rawLines.length; span++) {
      const window = rawLines.slice(index, index + span).join(" ");
      const trailing = window.match(/(?:^|\s)(\d{1,3})\s*$/);
      if (trailing) candidates.push({ text: window, quantity: Number(trailing[1]), lineIndex: index });
    }
  });
  const chosen = new Map<string, { score: number; lineIndex: number; quantity: number }>();
  candidates.forEach((candidate) => {
    const normalized = normalizeOcr(candidate.text); if (!normalized) return;
    const ranked = items.map((item) => {
      const aliases = recognitionAliases(item);
      const weights = [5, aliases[1]?.length >= 3 ? 4 : 2, 10, 1];
      const score = aliases.reduce((total, alias, index) => total + (normalized.includes(alias) ? (weights[index] ?? 7) : 0), 0);
      return { item, score };
    }).sort((a, b) => b.score - a.score);
    const best = ranked[0]; const second = ranked[1];
    if (!best || best.score < 6 || (second && best.score - second.score < 2 && best.score < 10)) return;
    const current = chosen.get(best.item.id);
    if (!current || best.score > current.score) chosen.set(best.item.id, { score: best.score, lineIndex: candidate.lineIndex, quantity: candidate.quantity });
  });
  const matches: PdfLine[] = [];
  for (const [productId, value] of [...chosen.entries()].sort((a, b) => a[1].lineIndex - b[1].lineIndex)) {
    matches.push({ productId, pieces: value.quantity, unitMode: "package" });
  }
  return matches;
}

function documentProductMatches(text: string, items: RecognizableProduct[]) {
  const rawLines = text.split(/\r?\n/).map((line) => line.normalize("NFKC").trim()).filter(Boolean);
  const chosen = new Map<string, { score: number; lineIndex: number }>();
  rawLines.forEach((_line, lineIndex) => {
    for (let span = 1; span <= 3 && lineIndex + span <= rawLines.length; span++) {
      const normalized = normalizeOcr(rawLines.slice(lineIndex, lineIndex + span).join(" ")); if (!normalized) continue;
      const ranked = items.map((item) => {
        const aliases = recognitionAliases(item);
        const weights = [5, aliases[1]?.length >= 3 ? 4 : 2, 10, 1];
        const score = aliases.reduce((total, alias, index) => total + (normalized.includes(alias) ? (weights[index] ?? 7) : 0), 0);
        return { item, score };
      }).sort((a, b) => b.score - a.score);
      const best = ranked[0]; const second = ranked[1];
      if (!best || best.score < 6 || (second && best.score - second.score < 2 && best.score < 10)) continue;
      const current = chosen.get(best.item.id);
      if (!current || best.score > current.score) chosen.set(best.item.id, { score: best.score, lineIndex });
    }
  });
  return [...chosen.entries()].sort((a, b) => a[1].lineIndex - b[1].lineIndex).map(([productId]) => productId);
}

function bestRecognizedProduct(text: string, items: RecognizableProduct[]) {
  const normalized = normalizeOcr(text); if (!normalized) return null;
  const ranked = items.map((item) => {
    const aliases = recognitionAliases(item);
    const weights = [5, aliases[1]?.length >= 3 ? 4 : 2, 10, 1];
    const score = aliases.reduce((total, alias, index) => total + (normalized.includes(alias) ? (weights[index] ?? 7) : 0), 0);
    return { item, score };
  }).sort((a, b) => b.score - a.score);
  const best = ranked[0]; const second = ranked[1];
  return best && best.score >= 6 && (!second || best.score - second.score >= 2 || best.score >= 10) ? best.item : null;
}

const ignoredOcrLine = /(?:[$€¥]|貨品清單|再次購買|優惠碼|折扣|合計|總計|小計|送貨|收貨|地址|電話|付款|訂單編號|order\s*(?:no|number)|subtotal|total|delivery|payment|aughd)/i;

function looksLikeProductText(value: string) {
  const text = value.replace(/\s+/g, " ").trim(); const normalized = normalizeOcr(text);
  const letters = [...text.matchAll(/[\p{L}]/gu)].length;
  return normalized.length >= 7 && letters >= 5 && !ignoredOcrLine.test(text);
}

function draftFromOcr(value: string): ProductDraft {
  const name = value.replace(/(?:^|\s)\d{1,3}\s*$/, "").replace(/\s+/g, " ").trim();
  const spec = name.match(/\d+(?:\.\d+)?\s*(?:g|kg|克|公斤|ml|l|毫升|公升)(?:\s*[x×]\s*\d{1,3})?|\d{1,3}\s*[x×]\s*\d+(?:\.\d+)?\s*(?:g|kg|克|公斤|ml|l|毫升|公升)/i)?.[0] ?? "";
  const leadingPack = spec.match(/^(\d{1,3})\s*[x×]/i)?.[1];
  const trailingPack = spec.match(/[x×]\s*(\d{1,3})$/i)?.[1];
  const packSize = Math.max(1, Number(leadingPack ?? trailingPack ?? 1));
  const category = /薯片|脆片|potato|chips/i.test(name) ? "薯片／脆片"
    : /朱古力|巧克力|chocolate|m&m|maltesers|kitkat/i.test(name) ? "朱古力"
    : /糖果|橡皮糖|gummy|candy/i.test(name) ? "糖果"
    : /餅|cookie|biscuit|cracker/i.test(name) ? "餅乾／米餅"
    : /咖啡|coffee/i.test(name) ? "咖啡"
    : /水|汽水|飲料|飲品|cola|soda|energy|ml|毫升/i.test(name) ? "飲品"
    : "未分類";
  return { category, subcategory: "未分類", brand: "待核對", flavor: "待核對", name: name || "未命名產品", spec, unit: "件", pack_size: packSize, low_stock_level: 0 };
}

function mergeDetectedLines(primary: PdfLine[], secondary: PdfLine[]) {
  const keys = new Set(primary.map((line) => line.productId || normalizeOcr(line.draft?.name ?? "")));
  return [...primary, ...secondary.filter((line) => {
    const key = line.productId || normalizeOcr(line.draft?.name ?? "");
    if (!key || keys.has(key)) return false; keys.add(key); return true;
  })];
}

function genericDocumentLines(text: string, items: RecognizableProduct[]) {
  const rawLines = text.split(/\r?\n/).map((line) => line.normalize("NFKC").replace(/\s+/g, " ").trim()).filter(Boolean);
  const results: PdfLine[] = []; const used = new Set<string>();
  rawLines.forEach((line, lineIndex) => {
    if (!looksLikeProductText(line)) return;
    for (let span = 1; span <= 4 && lineIndex + span <= rawLines.length; span++) {
      const window = rawLines.slice(lineIndex, lineIndex + span).join(" ");
      const quantity = Number(window.match(/(?:^|\s)(\d{1,3})\s*$/)?.[1] ?? 0);
      const productText = window.replace(/(?:^|\s)\d{1,3}\s*$/, "").trim();
      if (!quantity || !looksLikeProductText(productText)) continue;
      const recognized = bestRecognizedProduct(productText, items);
      const draft = recognized ? undefined : draftFromOcr(productText);
      const key = recognized?.id ?? normalizeOcr(draft?.name ?? "");
      if (!key || used.has(key)) break;
      used.add(key); results.push({ productId: recognized?.id ?? "", pieces: quantity, unitMode: "package", draft });
      break;
    }
  });
  return results;
}

function genericImageLines(text: string, quantities: number[], items: RecognizableProduct[]) {
  if (!quantities.length) return [];
  const rows = text.split(/\r?\n/).map((line) => line.normalize("NFKC").replace(/\s+/g, " ").trim())
    .filter((line) => looksLikeProductText(line));
  const results: PdfLine[] = []; const used = new Set<string>();
  for (const row of rows) {
    const recognized = bestRecognizedProduct(row, items); const draft = recognized ? undefined : draftFromOcr(row);
    const key = recognized?.id ?? normalizeOcr(draft?.name ?? ""); if (!key || used.has(key)) continue;
    used.add(key); results.push({ productId: recognized?.id ?? "", pieces: quantities[results.length], unitMode: "package", draft });
    if (results.length === quantities.length) break;
  }
  return results;
}

async function imageQuantityColumn(source: File) {
  const url = URL.createObjectURL(source);
  try {
    const image = await new Promise<HTMLImageElement>((resolve, reject) => {
      const element = new Image(); element.onload = () => resolve(element); element.onerror = reject; element.src = url;
    });
    const sourceX = Math.floor(image.naturalWidth * .78); const sourceY = Math.floor(image.naturalHeight * .08);
    const sourceWidth = image.naturalWidth - sourceX; const sourceHeight = Math.floor(image.naturalHeight * .84);
    const scale = 3; const canvas = document.createElement("canvas");
    canvas.width = sourceWidth * scale; canvas.height = sourceHeight * scale;
    const context = canvas.getContext("2d", { alpha: false, willReadFrequently: true }); if (!context) throw new Error("Canvas unavailable");
    context.drawImage(image, sourceX, sourceY, sourceWidth, sourceHeight, 0, 0, canvas.width, canvas.height);
    const pixels = context.getImageData(0, 0, canvas.width, canvas.height); let min = 255; let max = 0;
    for (let index = 0; index < pixels.data.length; index += 4) {
      const gray = Math.round(pixels.data[index] * .299 + pixels.data[index + 1] * .587 + pixels.data[index + 2] * .114);
      pixels.data[index] = gray; min = Math.min(min, gray); max = Math.max(max, gray);
    }
    const range = Math.max(1, max - min);
    for (let index = 0; index < pixels.data.length; index += 4) {
      const stretched = (pixels.data[index] - min) * 255 / range;
      const value = Math.max(0, Math.min(255, (stretched - 128) * 2.5 + 128));
      pixels.data[index] = value; pixels.data[index + 1] = value; pixels.data[index + 2] = value; pixels.data[index + 3] = 255;
    }
    context.putImageData(pixels, 0, 0); return canvas;
  } finally { URL.revokeObjectURL(url); }
}

async function recognizeImage(source: File, update: (progress: OcrProgress) => void) {
  const { createWorker, OEM, PSM } = await import("tesseract.js");
  const base = `${location.origin}${import.meta.env.BASE_URL}`;
  const worker = await createWorker(["eng", "chi_tra"], OEM.LSTM_ONLY, {
    workerPath: `${base}tesseract-worker.min.js`, langPath: `${base}tessdata`,
    corePath: `${base}tesseract-core`, workerBlobURL: false,
    logger: (message) => {
    if (message.status === "recognizing text") update({ label: "辨認圖片文字", percent: Math.round(message.progress * 100) });
  } });
  try {
    const result = await worker.recognize(source);
    update({ label: "辨認右側數量", percent: 90 });
    const quantityCanvas = await imageQuantityColumn(source);
    await worker.setParameters({ tessedit_pageseg_mode: PSM.SPARSE_TEXT, tessedit_char_whitelist: "0123456789" });
    const quantityResult = await worker.recognize(quantityCanvas, {}, { text: true, tsv: true });
    const quantities = (quantityResult.data.tsv ?? "").split(/\r?\n/).flatMap((row) => {
      const fields = row.split("\t"); if (fields[0] !== "5") return [];
      const left = Number(fields[6]); const confidence = Number(fields[10]); const value = Number(fields.slice(11).join("\t").trim());
      return left > quantityCanvas.width * .62 && confidence >= 70 && Number.isInteger(value) && value > 0 && value <= 999 ? [value] : [];
    });
    return { text: result.data.text, quantities };
  }
  finally { await worker.terminate(); }
}

function WorkspaceGate({ session }: { session: Session }) {
  const [workspaces, setWorkspaces] = useState<Workspace[]>([]);
  const [activeId, setActiveId] = useState(localStorage.getItem("stockcheck-workspace") ?? "");
  const [loading, setLoading] = useState(true);
  const [newName, setNewName] = useState("");
  const [claimCode, setClaimCode] = useState("");
  const [message, setMessage] = useState("");

  const load = async () => {
    setLoading(true);
    await supabase.rpc("accept_my_workspace_invites");
    const { data, error } = await supabase.from("workspace_members").select("role,workspaces!inner(id,name)").eq("user_id", session.user.id);
    if (error) { setMessage("未能載入店舖資料"); setLoading(false); return; }
    const next = (data ?? []).map((row: any) => ({ id: row.workspaces.id, name: row.workspaces.name, role: row.role })) as Workspace[];
    setWorkspaces(next);
    if (!next.some((item) => item.id === activeId)) setActiveId(next[0]?.id ?? "");
    setLoading(false);
  };

  useEffect(() => { load(); }, []);
  useEffect(() => { if (activeId) localStorage.setItem("stockcheck-workspace", activeId); }, [activeId]);

  const createWorkspace = async () => {
    if (!newName.trim()) return setMessage("請輸入店舖／倉庫名稱");
    const { data, error } = await supabase.rpc("create_workspace", { workspace_name: newName.trim() });
    if (error || !data) return setMessage("未能建立店舖，請稍後再試");
    setNewName(""); setActiveId(data as string); await load();
  };

  const claimExisting = async () => {
    if (!claimCode.trim()) return setMessage("請輸入一次性認領碼");
    const { data, error } = await supabase.rpc("claim_legacy_workspace", { claim_code: claimCode.trim() });
    if (error || !data) return setMessage("認領碼不正確，或者舊庫存已經被認領");
    setClaimCode(""); setMessage("舊庫存已成功連接到你嘅帳戶"); await load();
  };

  if (loading) return <main className="center-screen"><div className="spinner" /><p>載入你嘅店舖…</p></main>;
  if (!workspaces.length) return <main className="public-shell"><section className="hero-card onboarding-card"><div className="app-mark">＋</div><p className="eyebrow">建立獨立資料空間</p><h1>開設第一間店舖</h1><p>每間店舖都有自己嘅產品、庫存及盤點記錄。之後可以邀請同事一齊使用。</p><label className="login-field">店舖／倉庫名稱<input value={newName} onChange={(event) => setNewName(event.target.value)} placeholder="例如：ABC Shop" /></label><button className="primary-button" onClick={createWorkspace}>建立全新店舖</button><div className="claim-divider"><span>或者</span></div><section className="claim-card"><p className="eyebrow">原有 Stockcheck 管理員</p><strong>認領現有 53 款貨品</strong><div><input value={claimCode} onChange={(event) => setClaimCode(event.target.value)} placeholder="一次性認領碼" /><button onClick={claimExisting}>認領</button></div></section>{message && <p className="form-message error">{message}</p>}<button className="text-button" onClick={() => supabase.auth.signOut()}>登出</button></section></main>;
  const active = workspaces.find((item) => item.id === activeId) ?? workspaces[0];
  return <Stockcheck session={session} workspace={active} workspaces={workspaces} changeWorkspace={setActiveId} reloadWorkspaces={load} />;
}

function Stockcheck({ session, workspace, workspaces, changeWorkspace, reloadWorkspaces }: { session: Session; workspace: Workspace; workspaces: Workspace[]; changeWorkspace: (id: string) => void; reloadWorkspaces: () => Promise<void> }) {
  const [items, setItems] = useState<InventoryItem[]>([]);
  const [activity, setActivity] = useState<Activity[]>([]);
  const [tab, setTab] = useState<Tab>("count");
  const [query, setQuery] = useState("");
  const [stockDisplayMode, setStockDisplayMode] = useState<StockDisplayMode>("mixed");
  const [expanded, setExpanded] = useState<string | null>(null);
  const [counts, setCounts] = useState<Record<string, string>>({});
  const [countUnits, setCountUnits] = useState<Record<string, UnitMode>>({});
  const [busy, setBusy] = useState<string | null>(null);
  const [toast, setToast] = useState("");
  const [stockIn, setStockIn] = useState<{ productId: string; pieces: string; source: string; unitMode: UnitMode }>({ productId: "", pieces: "1", source: "手動入貨", unitMode: "package" });
  const [showNewProduct, setShowNewProduct] = useState(false);
  const [editingProduct, setEditingProduct] = useState<InventoryItem | null>(null);
  const [correctingEntry, setCorrectingEntry] = useState<Activity | null>(null);
  const [voidingEntry, setVoidingEntry] = useState<Activity | null>(null);
  const [showWorkspace, setShowWorkspace] = useState(false);
  const [showCategoryManager, setShowCategoryManager] = useState(false);
  const [pdf, setPdf] = useState<{ filename: string; orderNumber: string; lines: PdfLine[] } | null>(null);
  const [pdfBusy, setPdfBusy] = useState(false);
  const [ocrProgress, setOcrProgress] = useState<OcrProgress | null>(null);
  const [excelReview, setExcelReview] = useState<ExcelReview | null>(null);
  const [excelBusy, setExcelBusy] = useState(false);
  const fileRef = useRef<HTMLInputElement>(null);
  const inboundExcelRef = useRef<HTMLInputElement>(null);
  const stocktakeExcelRef = useRef<HTMLInputElement>(null);

  const refresh = async () => {
    const [{ data: stock, error: stockError }, { data: events, error: eventError }] = await Promise.all([
      supabase.from("inventory_current").select("*").eq("workspace_id", workspace.id).order("sort_order"),
      supabase.from("recent_activity").select("*").eq("workspace_id", workspace.id).order("happened_at", { ascending: false }).limit(30),
    ]);
    if (stockError || eventError) throw new Error(stockError?.message ?? eventError?.message ?? "未能載入共享庫存");
    const next = (stock ?? []) as InventoryItem[];
    setItems(next); setActivity((events ?? []) as Activity[]);
    if (!stockIn.productId && next[0]) setStockIn((value) => ({ ...value, productId: next[0].id }));
  };

  useEffect(() => {
    const saved = localStorage.getItem(`stockcheck:stock-display:${workspace.id}`);
    setStockDisplayMode(saved === "base" || saved === "package" || saved === "mixed" ? saved : "mixed");
  }, [workspace.id]);
  useEffect(() => { setItems([]); setActivity([]); setStockIn((value) => ({ ...value, productId: "" })); refresh().catch(() => setToast("未能載入共享庫存，請稍後再試")); }, [workspace.id]);
  useEffect(() => { if (workspace.role === "viewer" && (tab === "count" || tab === "inbound")) setTab("stock"); }, [workspace.id, workspace.role, tab]);
  useEffect(() => { if (!toast) return; const timer = setTimeout(() => setToast(""), 3000); return () => clearTimeout(timer); }, [toast]);

  const filtered = useMemo(() => {
    const needle = query.trim().toLowerCase();
    return needle ? items.filter((item) => [item.brand, item.flavor, item.name, item.category, item.subcategory].join(" ").toLowerCase().includes(needle)) : items;
  }, [items, query]);
  const groups = useMemo(() => {
    const map = new Map<string, InventoryItem[]>();
    filtered.forEach((item) => map.set(item.category, [...(map.get(item.category) ?? []), item]));
    return [...map.entries()];
  }, [filtered]);
  const subgroups = (products: InventoryItem[]) => {
    const map = new Map<string, InventoryItem[]>();
    products.forEach((item) => map.set(item.subcategory || "未分類", [...(map.get(item.subcategory || "未分類") ?? []), item]));
    return [...map.entries()];
  };
  const doneToday = items.filter((item) => item.stocktake_date === today()).length;
  const lowStock = items.filter((item) => item.current_qty <= item.low_stock_level).length;
  const canAdmin = workspace.role === "owner" || workspace.role === "admin";
  const canWrite = workspace.role !== "viewer";

  const saveCount = async (item: InventoryItem) => {
    const enteredQuantity = Number(counts[item.id]); const unitMode = countUnits[item.id] ?? "base";
    const quantity = unitMode === "package" ? enteredQuantity * item.pack_size : enteredQuantity;
    if (!Number.isInteger(enteredQuantity) || enteredQuantity < 0) return setToast("請輸入實際點到嘅數量");
    setBusy(item.id);
    const { error } = await supabase.from("stocktakes").insert({ workspace_id: workspace.id, product_id: item.id, quantity, entered_quantity: enteredQuantity, entered_unit: unitMode === "package" ? "箱／包" : item.unit, stocktake_date: today(), counted_by: session.user.id, counted_by_email: session.user.email });
    setBusy(null); if (error) return setToast("未能儲存盤點");
    setCounts((value) => ({ ...value, [item.id]: "" })); setToast(`${item.brand} ${item.flavor} 已完成盤點`); await refresh();
  };

  const saveInbound = async () => {
    const enteredQuantity = Number(stockIn.pieces); const item = items.find((entry) => entry.id === stockIn.productId);
    if (!item || !Number.isInteger(enteredQuantity) || enteredQuantity <= 0) return setToast("請輸入新增數量");
    const unitsAdded = stockIn.unitMode === "package" ? enteredQuantity * item.pack_size : enteredQuantity;
    setBusy("inbound");
    const { error } = await supabase.from("stock_ins").insert({ workspace_id: workspace.id, product_id: item.id, pieces: stockIn.unitMode === "package" ? enteredQuantity : 1, units_added: unitsAdded, entered_quantity: enteredQuantity, entered_unit: stockIn.unitMode === "package" ? "箱／包" : item.unit, source: stockIn.source, added_by: session.user.id, added_by_email: session.user.email });
    setBusy(null); if (error) return setToast("未能新增入貨");
    setStockIn((value) => ({ ...value, pieces: "1" })); setToast("入貨已同步到所有裝置"); await refresh();
  };

  const openInboundExcel = async (file?: File) => {
    if (!file) return;
    setExcelBusy(true);
    try {
      const rows = await parseInboundWorkbook(file);
      const orderNumbers = [...new Set(rows.map((row) => row.orderNumber.trim()).filter(Boolean))];
      if (orderNumbers.length > 1) throw new Error("同一份 Excel 只可以包含一個訂單編號");
      const lines: ExcelInboundLine[] = rows.map((row) => {
        const original: ProductDraft = { category: row.category || "其他", subcategory: row.subcategory || "未分類", brand: row.brand || "未提供", flavor: row.flavor || "未提供", name: row.name, spec: row.spec, unit: "件", pack_size: Math.max(1, row.packSize), low_stock_level: 0 };
        const match = matchExcelProduct(row, items);
        if (match) return { rowNumber: row.rowNumber, productId: match.item.id, quantity: row.quantity < 0 ? "" : row.quantity, unitMode: excelUnitMode(row.unit), confidence: match.score >= 75 ? "matched" : "suggested", original };
        return { rowNumber: row.rowNumber, productId: "", quantity: row.quantity < 0 ? "" : row.quantity, unitMode: excelUnitMode(row.unit), confidence: "new", original, draft: original };
      });
      setExcelReview({ kind: "inbound", filename: file.name, orderNumber: orderNumbers[0] ?? "", lines });
    } catch (error) { setToast(error instanceof Error ? error.message : "未能讀取入貨 Excel"); }
    finally { setExcelBusy(false); if (inboundExcelRef.current) inboundExcelRef.current.value = ""; }
  };

  const openStocktakeExcel = async (file?: File) => {
    if (!file) return;
    setExcelBusy(true);
    try {
      const parsed = await parseStocktakeWorkbook(file);
      if (parsed.workspaceId && parsed.workspaceId !== workspace.id) throw new Error("呢份 Stock Take 屬於另一間店舖");
      const seen = new Set<string>();
      const lines: ExcelStocktakeLine[] = parsed.rows.map((row) => {
        const item = items.find((candidate) => candidate.id === row.productId);
        if (!item) throw new Error(`第 ${row.rowNumber} 行產品已不存在`);
        if (seen.has(row.productId)) throw new Error(`第 ${row.rowNumber} 行產品重複`);
        seen.add(row.productId);
        if (row.countedQuantity < 0) throw new Error(`第 ${row.rowNumber} 行盤點數量不正確`);
        return { rowNumber: row.rowNumber, productId: row.productId, packageQuantity: row.packageQuantity, looseQuantity: row.looseQuantity, quantity: row.countedQuantity, expectedQty: row.exportedQuantity, conflictQty: item.current_qty !== row.exportedQuantity ? item.current_qty : undefined };
      });
      setExcelReview({ kind: "stocktake", filename: file.name, exportedAt: parsed.exportedAt, lines });
    } catch (error) { setToast(error instanceof Error ? error.message : "未能讀取 Stock Take Excel"); }
    finally { setExcelBusy(false); if (stocktakeExcelRef.current) stocktakeExcelRef.current.value = ""; }
  };

  const confirmInboundExcel = async (review: Extract<ExcelReview, { kind: "inbound" }>) => {
    const orderNumber = review.orderNumber.trim();
    const duplicateIds = review.lines.map((line, index) => line.productId || (line.draft ? productIdentity(line.draft) : `missing:${index}`));
    if (new Set(duplicateIds).size !== duplicateIds.length) return setToast("Excel 有重複產品，請刪除或合併後再確認");
    setBusy("excel-inbound");
    const existingIds = review.lines.map((line) => line.productId).filter(Boolean);
    if (orderNumber && existingIds.length) {
      const { data: duplicates, error: duplicateError } = await supabase.from("stock_ins").select("product_id").eq("workspace_id", workspace.id).eq("order_number", orderNumber).in("product_id", existingIds);
      if (duplicateError || duplicates?.length) { setBusy(null); return setToast(duplicates?.length ? "呢張訂單已有產品入過貨，已停止重複入貨" : "未能檢查重複訂單"); }
    }
    const createdIds = new Map<number, string>();
    const newLines = review.lines.filter((line) => line.draft);
    if (newLines.length && !canAdmin) { setBusy(null); return setToast("只有擁有人或管理員可以由 Excel 建立新產品"); }
    if (newLines.length) {
      const { data: created, error } = await supabase.from("products").insert(newLines.map((line) => ({ workspace_id: workspace.id, ...line.draft!, created_by: session.user.id }))).select("id");
      if (error || created?.length !== newLines.length) { setBusy(null); return setToast("未能建立 Excel 入面嘅新產品，庫存未有更新"); }
      newLines.forEach((line, index) => createdIds.set(review.lines.indexOf(line), created[index].id));
    }
    const rows = review.lines.map((line, index) => {
      const item = line.draft ?? items.find((candidate) => candidate.id === line.productId)!;
      const enteredQuantity = Number(line.quantity); const unitsAdded = line.unitMode === "package" ? enteredQuantity * item.pack_size : enteredQuantity;
      return { workspace_id: workspace.id, product_id: line.draft ? createdIds.get(index)! : line.productId, pieces: line.unitMode === "package" ? enteredQuantity : 1, units_added: unitsAdded, entered_quantity: enteredQuantity, entered_unit: line.unitMode === "package" ? "箱／包" : item.unit, source: `Excel 入貨: ${review.filename}`, order_number: orderNumber || null, added_by: session.user.id, added_by_email: session.user.email };
    });
    const { error } = await supabase.from("stock_ins").insert(rows);
    setBusy(null);
    if (error) return setToast(error.code === "23505" ? "呢張訂單已經入過貨" : "未能確認 Excel 入貨");
    setExcelReview(null); setToast(`${rows.length} 款 Excel 入貨已同步`); await refresh();
  };

  const confirmStocktakeExcel = async (review: Extract<ExcelReview, { kind: "stocktake" }>) => {
    setBusy("excel-stocktake");
    const { data, error: loadError } = await supabase.from("inventory_current").select("id,current_qty").eq("workspace_id", workspace.id).in("id", review.lines.map((line) => line.productId));
    if (loadError) { setBusy(null); return setToast("未能檢查最新庫存"); }
    const current = new Map((data ?? []).map((row) => [row.id as string, Number(row.current_qty)]));
    const checkedLines = review.lines.map((line) => ({ ...line, conflictQty: current.get(line.productId) !== line.expectedQty ? current.get(line.productId) : undefined }));
    if (checkedLines.some((line) => line.conflictQty !== undefined)) { setBusy(null); setExcelReview({ ...review, lines: checkedLines }); return setToast("有產品喺 Excel 匯出後被更新，請先核對衝突"); }
    const rows = review.lines.map((line) => {
      const item = items.find((candidate) => candidate.id === line.productId);
      const breakdown = `${Number(line.packageQuantity || 0)} 箱／包 + ${Number(line.looseQuantity || 0)} ${item?.unit ?? "件"}`;
      return { workspace_id: workspace.id, product_id: line.productId, quantity: line.quantity, entered_quantity: line.quantity, entered_unit: item?.unit ?? "件", stocktake_date: today(), source: `Excel 盤點: ${review.filename} (${breakdown})`, counted_by: session.user.id, counted_by_email: session.user.email };
    });
    const { error } = await supabase.from("stocktakes").insert(rows);
    setBusy(null); if (error) return setToast("未能確認 Excel Stock Take");
    setExcelReview(null); setToast(`${rows.length} 款 Excel 盤點已同步`); await refresh();
  };

  const handleDocument = async (file?: File) => {
    if (!file) return;
    if (file.size > 20 * 1024 * 1024) return setToast("檔案不可大過 20MB");
    const isPdf = file.type === "application/pdf" || file.name.toLowerCase().endsWith(".pdf");
    const isImage = file.type.startsWith("image/") || /\.(jpe?g|png)$/i.test(file.name);
    if (!isPdf && !isImage) return setToast("請選擇 PDF、JPG、JPEG 或 PNG");
    setPdfBusy(true); setOcrProgress({ label: "準備讀取檔案", percent: 0 });
    let failureStage = "FILE";
    try {
      let text = "";
      let imageQuantities: number[] = [];
      const candidates = recognitionProducts(items);
      if (isImage) {
        failureStage = "IMAGE-OCR";
        const recognized = await recognizeImage(file, setOcrProgress);
        text = recognized.text; imageQuantities = recognized.quantities;
      } else {
        failureStage = "PDF-ENGINE";
        const pdfjs = await import("pdfjs-dist/legacy/build/pdf.mjs");
        pdfjs.GlobalWorkerOptions.workerSrc = new URL("pdfjs-dist/legacy/build/pdf.worker.min.mjs", import.meta.url).toString();
        failureStage = "PDF-OPEN";
        const pdfDocument = await pdfjs.getDocument({ data: new Uint8Array(await file.arrayBuffer()) }).promise;
        let embeddedText = "";
        let embeddedTextAvailable = true;
        for (let pageNo = 1; pageNo <= pdfDocument.numPages; pageNo++) {
          setOcrProgress({ label: `讀取 PDF 第 ${pageNo}/${pdfDocument.numPages} 頁`, percent: Math.round(pageNo / pdfDocument.numPages * 20) });
          failureStage = `PDF-PAGE-${pageNo}`;
          const page = await pdfDocument.getPage(pageNo);
          failureStage = `PDF-TEXT-${pageNo}`;
          try {
            const content = await page.getTextContent();
            embeddedText += "\n" + content.items.map((part) => "str" in part ? part.str : "").join(" ");
          } catch (textError) {
            console.warn("PDF text layer unavailable; continuing with page OCR", { pageNo, textError });
            embeddedTextAvailable = false;
            embeddedText = "";
            break;
          }
        }
        const embeddedMatches = embeddedTextAvailable ? documentMatches(embeddedText, candidates) : [];
        if (embeddedMatches.length >= 20) text = embeddedText;
        else {
          failureStage = "OCR-START";
          const { createWorker, OEM } = await import("tesseract.js");
          const base = `${location.origin}${import.meta.env.BASE_URL}`;
          const worker = await createWorker(["eng", "chi_tra"], OEM.LSTM_ONLY, {
            workerPath: `${base}tesseract-worker.min.js`, langPath: `${base}tessdata`,
            corePath: `${base}tesseract-core`, workerBlobURL: false,
            logger: (message) => {
            if (message.status === "recognizing text") setOcrProgress((current) => ({ label: current?.label ?? "辨認 PDF", percent: Math.min(99, 20 + Math.round(message.progress * 80)) }));
          } });
          try {
            for (let pageNo = 1; pageNo <= pdfDocument.numPages; pageNo++) {
              failureStage = `OCR-PAGE-${pageNo}`;
              setOcrProgress({ label: `OCR 辨認第 ${pageNo}/${pdfDocument.numPages} 頁`, percent: Math.round(20 + (pageNo - 1) / pdfDocument.numPages * 80) });
              const page = await pdfDocument.getPage(pageNo);
              const mobile = /iPhone|iPad|iPod|Android/i.test(navigator.userAgent);
              const viewport = page.getViewport({ scale: mobile ? 1.6 : 1.7 });
              const canvas = document.createElement("canvas"); canvas.width = Math.ceil(viewport.width); canvas.height = Math.ceil(viewport.height);
              const context = canvas.getContext("2d", { alpha: false }); if (!context) throw new Error("Canvas unavailable");
              await page.render({ canvas, canvasContext: context, viewport }).promise;
              const result = await worker.recognize(canvas); text += "\n" + result.data.text;
            }
          } finally { await worker.terminate(); }
        }
      }
      setOcrProgress({ label: "配對產品及數量", percent: 100 });
      const productMatches = isImage ? documentProductMatches(text, candidates) : [];
      const knownMatches = imageQuantities.length && productMatches.length
        ? productMatches.slice(0, imageQuantities.length).map((productId, index) => ({ productId, pieces: imageQuantities[index], unitMode: "package" as UnitMode }))
        : documentMatches(text, candidates);
      const genericMatches = isImage ? genericImageLines(text, imageQuantities, candidates) : genericDocumentLines(text, candidates);
      const detectedMatches = isImage ? mergeDetectedLines(genericMatches, knownMatches) : mergeDetectedLines(knownMatches, genericMatches);
      const matches = detectedMatches.map((line) => {
        const template = catalogItems.find((item) => item.id === line.productId);
        if (!template) return line;
        return { ...line, productId: "", draft: { category: template.category, subcategory: template.subcategory, brand: template.brand, flavor: template.flavor, name: template.name, spec: template.spec, unit: template.unit, pack_size: template.pack_size, low_stock_level: 0 } };
      });
      setPdf({ filename: file.name, orderNumber: text.replace(/\s/g, "").match(/H\d{12}/i)?.[0]?.toUpperCase() ?? "", lines: matches });
      const newCount = matches.filter((line) => line.draft).length;
      setToast(matches.length ? `已辨認 ${matches.length} 款${newCount ? `（${newCount} 款新產品）` : ""}，請逐項核對` : "未能擷取產品行，請喺核對頁手動加入產品");
    } catch (error) { console.error("Document import failed", { stage: failureStage, error }); setToast(`未能讀取檔案（${failureStage}），請重試`); }
    finally { setPdfBusy(false); setOcrProgress(null); if (fileRef.current) fileRef.current.value = ""; }
  };

  const confirmPdf = async () => {
    if (!pdf?.lines.length) return; setBusy("pdf");
    const newLines = pdf.lines.filter((line) => line.draft);
    if (newLines.length && !canAdmin) { setBusy(null); return setToast("只有擁有人或管理員可以由訂單建立新產品"); }
    const createdIds = new Map<number, string>();
    if (newLines.length) {
      const drafts = newLines.map((line) => ({ workspace_id: workspace.id, ...line.draft!, created_by: session.user.id }));
      const { data: created, error: productError } = await supabase.from("products").insert(drafts).select("id");
      if (productError || created?.length !== newLines.length) { setBusy(null); return setToast("未能由訂單建立新產品，庫存未有更新"); }
      newLines.forEach((line, index) => createdIds.set(pdf.lines.indexOf(line), created[index].id));
    }
    const rows = pdf.lines.filter((line) => Number(line.pieces) > 0).map((line, index) => {
      const item = line.draft ?? items.find((entry) => entry.id === line.productId)!;
      const enteredQuantity = Number(line.pieces);
      const unitsAdded = line.unitMode === "package" ? enteredQuantity * item.pack_size : enteredQuantity;
      return { workspace_id: workspace.id, product_id: line.draft ? createdIds.get(index)! : line.productId, pieces: line.unitMode === "package" ? enteredQuantity : 1, units_added: unitsAdded, entered_quantity: enteredQuantity, entered_unit: line.unitMode === "package" ? "箱／包" : item.unit, source: `上載檔案: ${pdf.filename}`, order_number: pdf.orderNumber || null, added_by: session.user.id, added_by_email: session.user.email };
    });
    const { error } = await supabase.from("stock_ins").insert(rows);
    setBusy(null); if (error) return setToast(error.code === "23505" ? "呢張訂單已經入過貨" : "未能確認檔案入貨");
    setPdf(null); setToast("檔案入貨已同步到所有裝置"); await refresh();
  };

  return <main className="app-shell">
    <header className="topbar"><div><p className="eyebrow">獨立共享庫存</p><h1>倉點 <span>Stockcheck</span></h1></div><button className="avatar" title="管理店舖" onClick={() => setShowWorkspace(true)}>{(session.user.email ?? "U").slice(0, 1).toUpperCase()}</button></header>
    <div className="workspace-bar"><label><span>目前店舖</span><select value={workspace.id} onChange={(event) => changeWorkspace(event.target.value)}>{workspaces.map((item) => <option value={item.id} key={item.id}>{item.name}</option>)}</select></label><button onClick={() => setShowWorkspace(true)}>管理</button></div>
    <section className="summary-card"><div><span>今日盤點</span><strong>{doneToday}<small> / {items.length}</small></strong></div><div className="progress"><i style={{ width: `${items.length ? doneToday / items.length * 100 : 0}%` }} /></div><div className="summary-row"><span>{today()}</span><span className={lowStock ? "warning" : "good"}>{lowStock ? `${lowStock} 款低存量` : "庫存正常"}</span></div></section>
    {(tab === "count" || tab === "stock") && <label className="search"><span>⌕</span><input value={query} onChange={(event) => setQuery(event.target.value)} placeholder="搜尋品牌、味道或產品" /></label>}

    {tab === "count" && <section className="content-section"><div className="section-heading"><div><p className="eyebrow">主分類 → 子分類</p><h2>每日盤點</h2></div><span>{items.length - doneToday} 款未完成</span></div><div className="excel-tool-card"><div><span className="excel-badge">XLSX</span><div><strong>Excel 批量盤點</strong><p>匯出後可同時填「箱／包數量」及「散件數量」，Import 時會自動換算。</p></div></div><div className="excel-actions"><button onClick={() => downloadStocktakeWorkbook(items, workspace.name, workspace.id, today()).catch(() => setToast("未能建立 Stock Take Excel"))} disabled={excelBusy || !items.length}>Export 今日清單</button><button onClick={() => stocktakeExcelRef.current?.click()} disabled={excelBusy}>Import Stock Take</button><input ref={stocktakeExcelRef} hidden type="file" accept=".xlsx,application/vnd.openxmlformats-officedocument.spreadsheetml.sheet" onChange={(event) => openStocktakeExcel(event.target.files?.[0])} /></div></div>{!items.length && <EmptyProducts open={() => setTab("inbound")} />}<div className="category-list">{groups.map(([category, products]) => { const complete = products.filter((item) => item.stocktake_date === today()).length; const open = expanded === category || Boolean(query); return <article className="category" key={category}><button className="category-head" onClick={() => setExpanded(open && !query ? null : category)}><span className="category-icon">{category.slice(0, 1)}</span><span><strong>{category}</strong><small>{subgroups(products).length} 個子分類 · {products.length} 款產品</small></span><span className={complete === products.length ? "done-pill" : "count-pill"}>{complete}/{products.length}</span><b>{open ? "−" : "+"}</b></button>{open && <div className="product-list">{subgroups(products).map(([subcategory, childProducts]) => <section className="subcategory-group" key={subcategory}><h4>{subcategory}</h4>{childProducts.map((item) => <ProductCountCard key={item.id} item={item} value={counts[item.id] ?? ""} unitMode={countUnits[item.id] ?? "base"} onUnitChange={(unitMode) => setCountUnits((all) => ({ ...all, [item.id]: unitMode }))} onChange={(value) => setCounts((all) => ({ ...all, [item.id]: value }))} onSave={() => saveCount(item)} busy={busy === item.id} />)}</section>)}</div>}</article>; })}</div></section>}

    {tab === "stock" && <section className="content-section"><div className="section-heading stock-heading"><div><p className="eyebrow">主分類 → 子分類</p><h2>庫存清單</h2></div><div className="section-actions"><label className="stock-unit-picker"><span>顯示單位</span><select value={stockDisplayMode} onChange={(event) => { const mode = event.target.value as StockDisplayMode; setStockDisplayMode(mode); localStorage.setItem(`stockcheck:stock-display:${workspace.id}`, mode); }}><option value="mixed">箱／包 + 散件</option><option value="base">基本單位</option><option value="package">箱／包（小數）</option></select></label><span>{filtered.length} 款</span>{canAdmin && <button className="outline-button" onClick={() => setShowCategoryManager(true)}>分類設定</button>}</div></div><div className="stock-list">{groups.map(([category, products]) => <section key={category}><h3>{category}</h3>{subgroups(products).map(([subcategory, childProducts]) => <div className="stock-subcategory" key={subcategory}><h4>{subcategory}</h4>{childProducts.map((item) => { const display = stockDisplay(item, stockDisplayMode); return <button className="stock-row stock-edit-row" key={item.id} onClick={() => canAdmin && setEditingProduct(item)} disabled={!canAdmin}><div><strong>{item.brand} · {item.flavor}</strong><span>{item.name}｜{item.spec}｜每箱／包 {item.pack_size} {item.unit}</span></div><div className={item.current_qty <= item.low_stock_level ? "qty low" : "qty"}><strong>{display.value}</strong><small>{display.unit}{canAdmin ? " · 編輯 ›" : ""}</small></div></button>; })}</div>)}</section>)}</div></section>}

    {tab === "inbound" && canWrite && <section className="content-section"><div className="section-heading"><div><p className="eyebrow">增加庫存</p><h2>新貨入庫</h2></div>{canAdmin && <button className="outline-button" onClick={() => setShowNewProduct(true)}>＋ 新增產品</button>}</div><div className="form-card"><label>現有產品<select value={stockIn.productId} onChange={(event) => setStockIn({ ...stockIn, productId: event.target.value })}><option value="">請選擇</option>{items.map((item) => <option value={item.id} key={item.id}>{item.category}｜{item.brand}｜{item.flavor}</option>)}</select></label><div className="quantity-unit-row"><label>新增數量<input inputMode="numeric" value={stockIn.pieces} onChange={(event) => setStockIn({ ...stockIn, pieces: event.target.value.replace(/\D/g, "") })} /></label><label>輸入單位<select value={stockIn.unitMode} onChange={(event) => setStockIn({ ...stockIn, unitMode: event.target.value as UnitMode })}><option value="package">箱／包</option><option value="base">{items.find((item) => item.id === stockIn.productId)?.unit ?? "件"}</option></select></label></div>{stockIn.productId && <div className="conversion-note">自動換算：<strong>{stockIn.unitMode === "package" ? Number(stockIn.pieces || 0) * (items.find((item) => item.id === stockIn.productId)?.pack_size ?? 0) : Number(stockIn.pieces || 0)}</strong> {items.find((item) => item.id === stockIn.productId)?.unit}</div>}<label>來源<input value={stockIn.source} onChange={(event) => setStockIn({ ...stockIn, source: event.target.value })} /></label><button className="primary-button" onClick={saveInbound} disabled={busy === "inbound"}>{busy === "inbound" ? "儲存中…" : "確認入貨"}</button></div><div className="excel-tool-card inbound-excel"><div><span className="excel-badge">XLSX</span><div><strong>AI 訂單 Excel 入貨</strong><p>外部 AI 按固定欄位生成 Excel；Stockcheck 會自動配對產品再俾你核對。</p></div></div><div className="excel-actions"><button onClick={() => downloadInboundTemplate(workspace.name).catch(() => setToast("未能下載 Excel 範本"))} disabled={excelBusy}>下載格式範例</button><button onClick={() => inboundExcelRef.current?.click()} disabled={excelBusy}>{excelBusy ? "讀取中…" : "Import Excel"}</button><input ref={inboundExcelRef} hidden type="file" accept=".xlsx,application/vnd.openxmlformats-officedocument.spreadsheetml.sheet" onChange={(event) => openInboundExcel(event.target.files?.[0])} /></div></div></section>}

    {tab === "activity" && <section className="content-section"><div className="section-heading"><div><p className="eyebrow">可追查記錄</p><h2>最近操作</h2></div></div><div className="activity-list">{activity.length ? activity.map((entry) => { const canCorrect = canAdmin && entry.kind === "入貨" && !entry.is_voided; return <div className={`${entry.is_corrected ? "activity-row corrected" : "activity-row"}${entry.is_voided ? " voided" : ""}`} key={`${entry.kind}-${entry.id}`}><span className={entry.kind === "盤點" ? "activity-icon count" : "activity-icon inbound"}>{entry.is_voided ? "×" : entry.kind === "盤點" ? "✓" : "+"}</span><div><strong>{entry.product_name}{entry.is_corrected && <em>已更正</em>}{entry.is_voided && <em>已作廢</em>}</strong><p>{entry.source} · {entry.actor} · {new Date(entry.happened_at).toLocaleString("zh-HK")}</p>{entry.is_corrected && <small>原本：{entry.original_product_name} +{entry.original_quantity}；由 {entry.corrected_by_email} 更正</small>}{entry.is_voided && <small>作廢原因：{entry.void_reason}；由 {entry.voided_by_email} 作廢</small>}</div><aside><b>{entry.kind === "盤點" ? entry.quantity : `+${entry.quantity}`}</b>{canCorrect && <button onClick={() => setCorrectingEntry(entry)}>更正</button>}{canAdmin && !entry.is_voided && <button className="danger-link" onClick={() => setVoidingEntry(entry)}>作廢</button>}</aside></div>; }) : <div className="empty">未有操作記錄</div>}</div></section>}

    <div className="ad-safe-gap" aria-label="Google 廣告安全區" />
    <nav className="bottom-nav">{([["count","盤點","✓"],["stock","庫存","▦"],["inbound","入貨","＋"],["activity","記錄","◷"]] as [Tab,string,string][]).filter(([id]) => canWrite || (id !== "count" && id !== "inbound")).map(([id,label,icon]) => <button key={id} className={tab === id ? "active" : ""} onClick={() => setTab(id)}><span>{icon}</span>{label}</button>)}</nav>
    {showNewProduct && <NewProductDialog session={session} workspaceId={workspace.id} items={items} close={() => setShowNewProduct(false)} saved={async () => { setShowNewProduct(false); setToast("新產品已加入共享清單"); await refresh(); }} />}
    {editingProduct && <EditProductDialog item={editingProduct} items={items} close={() => setEditingProduct(null)} saved={async () => { setEditingProduct(null); setToast("產品資料已同步到所有裝置"); await refresh(); }} />}
    {correctingEntry && <CorrectStockInDialog entry={correctingEntry} items={items} workspace={workspace} close={() => setCorrectingEntry(null)} saved={async () => { setCorrectingEntry(null); setToast("入貨記錄及庫存已更正"); await refresh(); }} />}
    {voidingEntry && <VoidActivityDialog entry={voidingEntry} workspace={workspace} close={() => setVoidingEntry(null)} saved={async (count) => { setVoidingEntry(null); setToast(`${count} 筆記錄已作廢，庫存已重新計算`); await refresh(); }} />}
    {showWorkspace && <WorkspaceDialog session={session} workspace={workspace} workspaces={workspaces} changeWorkspace={changeWorkspace} reload={reloadWorkspaces} close={() => setShowWorkspace(false)} />}
    {showCategoryManager && <CategoryManager items={items} workspace={workspace} close={() => setShowCategoryManager(false)} saved={async (count, source, target) => { setToast(`${count} 款產品已搬到「${target} → ${source}」`); await refresh(); }} />}
    {pdf && <UploadReview pdf={pdf} items={items} setPdf={setPdf} confirm={confirmPdf} busy={busy === "pdf"} />}
    {excelReview && <ExcelReviewPage review={excelReview} items={items} setReview={setExcelReview} confirmInbound={() => excelReview.kind === "inbound" && confirmInboundExcel(excelReview)} confirmStocktake={() => excelReview.kind === "stocktake" && confirmStocktakeExcel(excelReview)} busy={busy === "excel-inbound" || busy === "excel-stocktake"} />}
    {toast && <div className="toast">{toast}</div>}
  </main>;
}

function EmptyProducts({ open }: { open: () => void }) { return <div className="empty-card"><strong>未有產品</strong><p>可以上載第一張訂單自動建立產品，或者手動新增。</p><button className="primary-button" onClick={open}>前往入貨</button></div>; }

function ExpandedChoicePicker({ label, options, value, onChange }: { label: string; options: string[]; value: string; onChange: (value: string) => void }) {
  const [custom, setCustom] = useState(Boolean(value && !options.includes(value)));
  useEffect(() => { if (value && options.includes(value)) setCustom(false); }, [value, options.join("|")]);
  return <div className="category-picker"><div className="category-picker-head"><span>{label}</span><button onClick={() => { setCustom((current) => !current); onChange(custom ? (options[0] ?? "") : ""); }}>{custom ? `顯示現有${label}` : `＋ 新增${label}`}</button></div>{custom ? <input autoFocus value={value} onChange={(event) => onChange(event.target.value)} placeholder={`輸入新${label}名稱`} /> : <div className="category-options">{options.map((option) => <button className={value === option ? "selected" : ""} onClick={() => onChange(option)} key={option}>{option}</button>)}</div>}<small>{custom ? `輸入未使用過嘅${label}名稱。` : `所有現有${label}已展開，直接點選一個。`}</small></div>;
}

function CategoryManager({ items, workspace, close, saved }: { items: InventoryItem[]; workspace: Workspace; close: () => void; saved: (count: number, source: string, target: string) => Promise<void> }) {
  const categories = useMemo(() => [...new Set(items.map((item) => item.category))].sort((a, b) => a.localeCompare(b, "zh-HK")), [items]);
  const [source, setSource] = useState(categories[0] ?? "");
  const [target, setTarget] = useState(categories.find((category) => category !== source) ?? "");
  const [customTarget, setCustomTarget] = useState(false);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState("");
  const affected = items.filter((item) => item.category === source);
  const targetChoices = categories.filter((category) => category !== source);
  const cleanTarget = target.trim();

  useEffect(() => {
    if (categories.length && !categories.includes(source)) setSource(categories[0]);
  }, [categories.join("|"), source]);
  useEffect(() => {
    if (!customTarget && (!targetChoices.includes(target) || target === source)) setTarget(targetChoices[0] ?? "");
  }, [source, categories.join("|"), customTarget, target]);

  const move = async () => {
    if (!source || !cleanTarget || source === cleanTarget) return setMessage("請揀一個唔同嘅目標主分類");
    setBusy(true); setMessage("");
    const { data, error } = await supabase.rpc("move_category_to_subcategory", { target_workspace: workspace.id, source_category: source, target_category: cleanTarget });
    setBusy(false);
    if (error) return setMessage("未能搬移分類，請確認你有管理員權限後再試");
    await saved(Number(data), source, cleanTarget);
    setMessage(`完成：${Number(data)} 款產品已搬入「${cleanTarget}」`);
  };

  return <div className="review-page category-manager-page">
    <header className="review-topbar"><button onClick={close}>← 返回</button><div><p className="eyebrow">產品目錄</p><h2>分類設定</h2></div><span>{categories.length} 個</span></header>
    <section className="category-manager-intro"><p className="eyebrow">目前兩層結構</p><h3>主分類及子分類</h3><p>每個分類分開顯示，括號內係產品數量。呢度只整理分類，唔會改產品、庫存或記錄。</p></section>
    <section className="category-tree">{categories.map((category) => {
      const products = items.filter((item) => item.category === category);
      const children = [...new Set(products.map((item) => item.subcategory || "未分類"))].sort((a, b) => a.localeCompare(b, "zh-HK"));
      return <article key={category}><div><span className="category-icon">{category.slice(0, 1)}</span><div><strong>{category}</strong><small>{products.length} 款產品 · {children.length} 個子分類</small></div></div><div className="category-child-list">{children.map((child) => <span key={child}>{child} <b>{products.filter((item) => (item.subcategory || "未分類") === child).length}</b></span>)}</div></article>;
    })}</section>
    <section className="category-move-card"><p className="eyebrow">批量整理</p><h3>將現有主分類搬入子分類</h3><label>要搬嘅現有主分類<select value={source} onChange={(event) => { setSource(event.target.value); setMessage(""); }}>{categories.map((category) => <option value={category} key={category}>{category}</option>)}</select></label>
      <div className="category-picker"><div className="category-picker-head"><span>目標主分類</span><button onClick={() => { setCustomTarget((current) => !current); setTarget(customTarget ? (targetChoices[0] ?? "") : ""); setMessage(""); }}>{customTarget ? "選擇現有主分類" : "＋ 新增主分類"}</button></div>{customTarget ? <input autoFocus value={target} onChange={(event) => setTarget(event.target.value)} placeholder="例如：零食、飲品、日用品" /> : <div className="category-options">{targetChoices.map((category) => <button className={target === category ? "selected" : ""} onClick={() => setTarget(category)} key={category}>{category}</button>)}</div>}<small>{customTarget ? "輸入新嘅大分類名稱。" : "點選一個現有大分類。"}</small></div>
      <div className="category-preview"><span>搬移預覽</span><strong>{source || "來源分類"}（{affected.length} 款）</strong><b>↓</b><strong>{cleanTarget || "目標主分類"} → {source || "子分類"}</strong></div>
      <div className="status-note">確認後，呢 {affected.length} 款產品會保留原有 ID、名稱、庫存、盤點、入貨及 OCR 對應。</div>
      {message && <p className={message.startsWith("完成") ? "form-message" : "form-message error"}>{message}</p>}
      <button className="primary-button" onClick={move} disabled={busy || !affected.length || !cleanTarget || source === cleanTarget}>{busy ? "搬移中…" : `確認搬移 ${affected.length} 款產品`}</button>
    </section>
  </div>;
}

function EditProductDialog({ item, items, close, saved }: { item: InventoryItem; items: InventoryItem[]; close: () => void; saved: () => Promise<void> }) {
  const [form, setForm] = useState({ category: item.category, subcategory: item.subcategory, brand: item.brand, flavor: item.flavor, name: item.name, spec: item.spec, unit: item.unit, packSize: String(item.pack_size), lowStockLevel: String(item.low_stock_level) });
  const [busy, setBusy] = useState(false); const [error, setError] = useState("");
  const change = (key: keyof typeof form, value: string) => setForm((current) => ({ ...current, [key]: value }));
  const categories = [...new Set(items.map((product) => product.category))].sort();
  const subcategories = [...new Set(items.filter((product) => product.category === form.category).map((product) => product.subcategory))].sort();
  const save = async () => {
    const packSize = Number(form.packSize); const low = Number(form.lowStockLevel);
    if (![form.category, form.subcategory, form.brand, form.flavor, form.name, form.unit].every((value) => value.trim()) || !Number.isInteger(packSize) || packSize < 1 || !Number.isInteger(low) || low < 0) return setError("請填妥產品資料及正確數量");
    setBusy(true);
    const { error: updateError } = await supabase.from("products").update({ category: form.category.trim(), subcategory: form.subcategory.trim(), brand: form.brand.trim(), flavor: form.flavor.trim(), name: form.name.trim(), spec: form.spec.trim(), unit: form.unit.trim(), pack_size: packSize, low_stock_level: low }).eq("id", item.id);
    setBusy(false); if (updateError) return setError("未能更新產品資料"); await saved();
  };
  return <div className="modal-backdrop"><section className="modal"><div className="modal-head"><div><p className="eyebrow">產品目錄</p><h2>編輯產品</h2></div><button onClick={close}>取消</button></div><div className="modal-form"><ExpandedChoicePicker label="主分類" options={categories} value={form.category} onChange={(category) => setForm({ ...form, category, subcategory: items.find((product) => product.category === category)?.subcategory ?? "" })} /><ExpandedChoicePicker label="子分類" options={subcategories} value={form.subcategory} onChange={(subcategory) => change("subcategory", subcategory)} /><div className="two-fields"><label>品牌<input value={form.brand} onChange={(event) => change("brand", event.target.value)} /></label><label>味道<input value={form.flavor} onChange={(event) => change("flavor", event.target.value)} /></label></div><label>產品名稱<input value={form.name} onChange={(event) => change("name", event.target.value)} /></label><div className="two-fields"><label>規格<input value={form.spec} onChange={(event) => change("spec", event.target.value)} /></label><label>基本單位<input value={form.unit} onChange={(event) => change("unit", event.target.value)} /></label></div><div className="two-fields"><label>每箱／包件數<input inputMode="numeric" value={form.packSize} onChange={(event) => change("packSize", event.target.value.replace(/\D/g, ""))} /></label><label>低存量提示<input inputMode="numeric" value={form.lowStockLevel} onChange={(event) => change("lowStockLevel", event.target.value.replace(/\D/g, ""))} /></label></div><div className="status-note">主分類及子分類會同步到所有裝置，舊記錄仍然保留。</div>{error && <p className="form-message error">{error}</p>}<button className="primary-button" onClick={save} disabled={busy}>{busy ? "同步中…" : "儲存產品資料"}</button></div></section></div>;
}

function CorrectStockInDialog({ entry, items, workspace, close, saved }: { entry: Activity; items: InventoryItem[]; workspace: Workspace; close: () => void; saved: () => Promise<void> }) {
  const initialItem = items.find((product) => product.id === entry.product_id);
  const [form, setForm] = useState({ productId: entry.product_id, productName: initialItem?.name ?? entry.product_name, category: initialItem?.category ?? "", subcategory: initialItem?.subcategory ?? "未分類", quantity: String(entry.entered_quantity), unitMode: (entry.entered_unit === "箱／包" ? "package" : "base") as UnitMode });
  const [busy, setBusy] = useState(false); const [error, setError] = useState("");
  const item = items.find((product) => product.id === form.productId);
  const categories = [...new Set(items.map((product) => product.category))].sort();
  const subcategories = [...new Set(items.filter((product) => product.category === form.category).map((product) => product.subcategory))].sort();
  const enteredQuantity = Number(form.quantity); const units = form.unitMode === "package" ? enteredQuantity * (item?.pack_size ?? 0) : enteredQuantity;
  const save = async () => {
    if (!item || !form.productName.trim() || !form.category.trim() || !form.subcategory.trim() || !Number.isInteger(enteredQuantity) || enteredQuantity <= 0) return setError("請填妥產品資料及正確數量");
    setBusy(true);
    const { error: updateError } = await supabase.rpc("correct_stock_in", { target_workspace: workspace.id, target_stock_in: entry.id, target_product: item.id, target_quantity: enteredQuantity, target_unit_mode: form.unitMode, target_product_name: form.productName.trim(), target_category: form.category.trim(), target_subcategory: form.subcategory.trim() });
    setBusy(false); if (updateError) return setError("未能更正入貨；請確認你有操作權限"); await saved();
  };
  return <div className="modal-backdrop"><section className="modal correction-modal"><div className="modal-head"><div><p className="eyebrow">保留原記錄</p><h2>更正入貨</h2></div><button onClick={close}>取消</button></div><div className="original-entry"><span>原本記錄</span><strong>{entry.original_product_name ?? entry.product_name} · +{entry.original_quantity ?? entry.quantity}</strong><small>{entry.actor} · {new Date(entry.happened_at).toLocaleString("zh-HK")}</small></div><div className="modal-form"><label>正確產品<select value={form.productId} onChange={(event) => { const product = items.find((candidate) => candidate.id === event.target.value); if (product) setForm({ ...form, productId: product.id, productName: product.name, category: product.category, subcategory: product.subcategory }); }}>{items.map((product) => <option key={product.id} value={product.id}>{product.category}｜{product.subcategory}｜{product.brand}｜{product.flavor}</option>)}</select></label><label>產品名稱<input value={form.productName} onChange={(event) => setForm({ ...form, productName: event.target.value })} /></label><ExpandedChoicePicker label="主分類" options={categories} value={form.category} onChange={(category) => setForm({ ...form, category, subcategory: items.find((product) => product.category === category)?.subcategory ?? "" })} /><ExpandedChoicePicker label="子分類" options={subcategories} value={form.subcategory} onChange={(subcategory) => setForm({ ...form, subcategory })} /><div className="quantity-unit-row"><label>正確數量<input inputMode="numeric" value={form.quantity} onChange={(event) => setForm({ ...form, quantity: event.target.value.replace(/\D/g, "") })} /></label><label>輸入單位<select value={form.unitMode} onChange={(event) => setForm({ ...form, unitMode: event.target.value as UnitMode })}><option value="package">箱／包</option><option value="base">{item?.unit ?? "件"}</option></select></label></div><div className="conversion-note">更正後入貨：<strong>{Number.isFinite(units) ? units : 0}</strong> {item?.unit}</div><div className="status-note">產品、兩層分類及入貨數量會一次過同步，原資料仍會保留。</div>{error && <p className="form-message error">{error}</p>}<button className="primary-button" onClick={save} disabled={busy || !form.quantity}>{busy ? "更正中…" : "確認更正"}</button></div></section></div>;
}

function ProductCountCard({ item, value, unitMode, onUnitChange, onChange, onSave, busy }: { item: InventoryItem; value: string; unitMode: UnitMode; onUnitChange: (v: UnitMode) => void; onChange: (v: string) => void; onSave: () => void; busy: boolean }) {
  const done = item.stocktake_date === today();
  const converted = unitMode === "package" ? Number(value || 0) * item.pack_size : Number(value || 0);
  return <div className={done ? "product-card complete" : "product-card"}><div className="product-copy"><div><strong>{item.brand}</strong><span>{item.flavor}</span></div><p>{item.name} · {item.spec}</p><small>{done ? `${item.counted_by_email} 今日已盤點` : `上次：${item.stocktake_date ?? "未盤點"}`}</small></div><div className="count-area"><div className="count-control"><label><input inputMode="numeric" pattern="[0-9]*" placeholder={unitMode === "base" ? String(item.current_qty) : "0"} value={value} onChange={(event) => onChange(event.target.value.replace(/\D/g, ""))} /><select aria-label="盤點單位" value={unitMode} onChange={(event) => onUnitChange(event.target.value as UnitMode)}><option value="base">{item.unit}</option><option value="package">箱／包</option></select></label><button onClick={onSave} disabled={busy}>{busy ? "…" : done ? "更新" : "完成"}</button></div>{value && <small className="inline-conversion">＝ {converted} {item.unit}</small>}</div></div>;
}

function NewProductDialog({ session, workspaceId, items, close, saved }: { session: Session; workspaceId: string; items: InventoryItem[]; close: () => void; saved: () => Promise<void> }) {
  const categories = [...new Set(items.map((product) => product.category))].sort();
  const [form, setForm] = useState<NewProduct>({ category: categories[0] ?? "", subcategory: items.find((product) => product.category === categories[0])?.subcategory ?? "", brand: "", flavor: "", name: "", spec: "", unit: "件", packSize: "1", initialPieces: "1", lowStockLevel: "0" });
  const [busy, setBusy] = useState(false); const [error, setError] = useState("");
  const change = (key: keyof NewProduct, value: string) => setForm((all) => ({ ...all, [key]: value }));
  const save = async () => {
    const packSize = Number(form.packSize); const initialPieces = Number(form.initialPieces); const low = Number(form.lowStockLevel);
    if (![form.category, form.subcategory, form.brand, form.flavor, form.name].every((v) => v.trim()) || !Number.isInteger(packSize) || packSize < 1 || !Number.isInteger(initialPieces) || initialPieces < 0 || !Number.isInteger(low) || low < 0) return setError("請填妥產品資料及正確數量");
    setBusy(true);
    const { data, error: productError } = await supabase.from("products").insert({ workspace_id: workspaceId, category: form.category.trim(), subcategory: form.subcategory.trim(), brand: form.brand.trim(), flavor: form.flavor.trim(), name: form.name.trim(), spec: form.spec.trim(), unit: form.unit.trim() || "件", pack_size: packSize, low_stock_level: low, created_by: session.user.id }).select("id").single();
    if (productError || !data) { setBusy(false); return setError("未能新增產品"); }
    if (initialPieces > 0) {
      const { error: stockError } = await supabase.from("stock_ins").insert({ workspace_id: workspaceId, product_id: data.id, pieces: initialPieces, units_added: initialPieces * packSize, entered_quantity: initialPieces, entered_unit: "箱／包", source: "首次入貨", added_by: session.user.id, added_by_email: session.user.email });
      if (stockError) { setBusy(false); return setError("產品已建立，但首次入貨未能儲存"); }
    }
    setBusy(false); await saved();
  };
  const subcategories = [...new Set(items.filter((product) => product.category === form.category).map((product) => product.subcategory))].sort();
  return <div className="modal-backdrop"><section className="modal"><div className="modal-head"><div><p className="eyebrow">共享產品目錄</p><h2>新增產品</h2></div><button onClick={close}>取消</button></div><div className="modal-form"><ExpandedChoicePicker label="主分類" options={categories} value={form.category} onChange={(category) => setForm({ ...form, category, subcategory: items.find((product) => product.category === category)?.subcategory ?? "" })} /><ExpandedChoicePicker label="子分類" options={subcategories} value={form.subcategory} onChange={(subcategory) => change("subcategory", subcategory)} /><div className="two-fields"><label>品牌<input value={form.brand} onChange={(e) => change("brand", e.target.value)} /></label><label>味道<input value={form.flavor} onChange={(e) => change("flavor", e.target.value)} /></label></div><label>產品名稱<input value={form.name} onChange={(e) => change("name", e.target.value)} /></label><div className="two-fields"><label>規格<input value={form.spec} onChange={(e) => change("spec", e.target.value)} placeholder="例如 25g x 30" /></label><label>盤點單位<input value={form.unit} onChange={(e) => change("unit", e.target.value)} placeholder="小包" /></label></div><div className="three-fields"><label>每箱／包件數<input inputMode="numeric" value={form.packSize} onChange={(e) => change("packSize", e.target.value.replace(/\D/g, ""))} /></label><label>首次箱／包數<input inputMode="numeric" value={form.initialPieces} onChange={(e) => change("initialPieces", e.target.value.replace(/\D/g, ""))} /></label><label>低存量警示<input inputMode="numeric" value={form.lowStockLevel} onChange={(e) => change("lowStockLevel", e.target.value.replace(/\D/g, ""))} /></label></div>{error && <p className="form-message error">{error}</p>}<button className="primary-button" onClick={save} disabled={busy}>{busy ? "儲存中…" : "建立並加入首次入貨"}</button></div></section></div>;
}

function VoidActivityDialog({ entry, workspace, close, saved }: { entry: Activity; workspace: Workspace; close: () => void; saved: (count: number) => Promise<void> }) {
  const [reason, setReason] = useState("");
  const [wholeBatch, setWholeBatch] = useState(Boolean(entry.order_number));
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const confirm = async () => {
    if (reason.trim().length < 2) return setError("請輸入作廢原因");
    setBusy(true); setError("");
    const { data, error: voidError } = await supabase.rpc("void_activity_record", { target_workspace: workspace.id, target_kind: entry.kind, target_id: entry.id, target_reason: reason.trim(), target_batch: wholeBatch });
    setBusy(false);
    if (voidError || !data) return setError("未能作廢記錄，請確認你有管理員權限");
    await saved(Number(data));
  };
  return <div className="modal-backdrop"><section className="modal danger-modal"><div className="modal-head"><div><p className="eyebrow">保留追查資料</p><h2>作廢整筆記錄</h2></div><button onClick={close}>取消</button></div><div className="original-entry"><span>{entry.kind}記錄</span><strong>{entry.product_name} · {entry.kind === "入貨" ? "+" : ""}{entry.quantity}</strong><small>{entry.actor} · {new Date(entry.happened_at).toLocaleString("zh-HK")}</small></div>{entry.order_number && <label className="batch-choice"><input type="checkbox" checked={wholeBatch} onChange={(event) => setWholeBatch(event.target.checked)} /><span><strong>作廢整張訂單</strong><small>訂單 {entry.order_number} 內所有產品會一併取消入貨。</small></span></label>}<div className="modal-form"><label>作廢原因<input autoFocus value={reason} onChange={(event) => setReason(event.target.value)} placeholder="例如：重複入貨、輸入錯誤" /></label><div className="status-note">作廢後不會計入庫存，但原記錄及原因仍會保留。</div>{error && <p className="form-message error">{error}</p>}<button className="danger-button" onClick={confirm} disabled={busy}>{busy ? "處理中…" : wholeBatch && entry.order_number ? "確認作廢整張訂單" : "確認作廢記錄"}</button></div></section></div>;
}

function WorkspaceDialog({ session, workspace, workspaces, changeWorkspace, reload, close }: { session: Session; workspace: Workspace; workspaces: Workspace[]; changeWorkspace: (id: string) => void; reload: () => Promise<void>; close: () => void }) {
  const [members, setMembers] = useState<WorkspaceMember[]>([]);
  const [inviteEmail, setInviteEmail] = useState("");
  const [inviteRole, setInviteRole] = useState<Exclude<WorkspaceRole, "owner">>("member");
  const [storeName, setStoreName] = useState(workspace.name);
  const [newName, setNewName] = useState("");
  const [message, setMessage] = useState("");
  const [busy, setBusy] = useState(false);
  const canManage = workspace.role === "owner" || workspace.role === "admin";
  const canRename = workspace.role === "owner";

  const loadMembers = async () => {
    const { data } = await supabase.from("workspace_members").select("user_id,email,role").eq("workspace_id", workspace.id).order("joined_at");
    setMembers((data ?? []) as WorkspaceMember[]);
  };
  useEffect(() => { setStoreName(workspace.name); setMessage(""); if (workspace.role !== "owner" && inviteRole === "admin") setInviteRole("member"); loadMembers(); }, [workspace.id, workspace.name, workspace.role]);

  const invite = async () => {
    const email = inviteEmail.trim().toLowerCase();
    if (!email.includes("@")) return setMessage("請輸入正確電郵地址");
    setBusy(true);
    const { error } = await supabase.from("workspace_invites").insert({ workspace_id: workspace.id, email, role: inviteRole, invited_by: session.user.id });
    setBusy(false);
    if (error) return setMessage(error.code === "23505" ? "呢個電郵已經邀請過" : "未能建立邀請");
    setInviteEmail(""); setMessage(`邀請已建立，對方登入後會成為「${roleLabel(inviteRole)}」。`);
  };

  const rename = async () => {
    if (!storeName.trim()) return setMessage("請輸入店舖名稱");
    setBusy(true);
    const { error } = await supabase.rpc("rename_workspace", { target_workspace: workspace.id, new_name: storeName.trim() });
    setBusy(false);
    if (error) return setMessage("未能修改店舖名稱");
    await reload(); setMessage("店舖名稱已同步到所有裝置");
  };

  const changeRole = async (member: WorkspaceMember, role: Exclude<WorkspaceRole, "owner">) => {
    setBusy(true); setMessage("");
    const { error } = await supabase.rpc("update_workspace_member_role", { target_workspace: workspace.id, target_user: member.user_id, new_role: role });
    setBusy(false);
    if (error) return setMessage("未能修改權限；只有擁有人可以管理其他管理員");
    await loadMembers(); setMessage(`${member.email} 已改為「${roleLabel(role)}」`);
  };

  const removeMember = async (member: WorkspaceMember) => {
    if (!window.confirm(`確定移除 ${member.email}？對方會立即失去呢間店嘅存取權。`)) return;
    setBusy(true); setMessage("");
    const { error } = await supabase.rpc("remove_workspace_member", { target_workspace: workspace.id, target_user: member.user_id });
    setBusy(false);
    if (error) return setMessage("未能移除成員；只有擁有人可以移除管理員");
    await loadMembers(); setMessage(`${member.email} 已移除`);
  };

  const createAnother = async () => {
    if (!newName.trim()) return setMessage("請輸入新店舖名稱");
    setBusy(true);
    const { data, error } = await supabase.rpc("create_workspace", { workspace_name: newName.trim() });
    setBusy(false);
    if (error || !data) return setMessage("未能建立新店舖");
    setNewName(""); await reload(); changeWorkspace(data as string); setMessage("新店舖已建立");
  };

  return <div className="modal-backdrop"><section className="modal workspace-modal"><div className="modal-head"><div><p className="eyebrow">Workspace</p><h2>店舖及成員</h2></div><button onClick={close}>完成</button></div><label className="workspace-picker">切換店舖<select value={workspace.id} onChange={(event) => changeWorkspace(event.target.value)}>{workspaces.map((item) => <option value={item.id} key={item.id}>{item.name}</option>)}</select></label>{canRename && <section className="workspace-form"><p className="eyebrow">店舖名稱</p><div><input value={storeName} onChange={(event) => setStoreName(event.target.value)} maxLength={80} /><button onClick={rename} disabled={busy || storeName.trim() === workspace.name}>儲存</button></div><small>只有擁有人可以改名；庫存及記錄不受影響。</small></section>}<section className="member-panel permission-panel"><div className="panel-title"><strong>{workspace.name}</strong><span>{roleLabel(workspace.role)}</span></div>{members.map((member) => { const locked = member.role === "owner" || (workspace.role === "admin" && member.role === "admin"); return <div className="member-row" key={member.user_id}><span>{member.email}{member.user_id === session.user.id && <small>你</small>}</span>{canManage && !locked ? <div className="member-actions"><select value={member.role} onChange={(event) => changeRole(member, event.target.value as Exclude<WorkspaceRole, "owner">)} disabled={busy}><option value="member">一般成員</option><option value="viewer">只供查看</option>{workspace.role === "owner" && <option value="admin">管理員</option>}</select><button onClick={() => removeMember(member)} disabled={busy}>移除</button></div> : <b>{roleLabel(member.role)}</b>}</div>; })}</section>{canManage && <section className="workspace-form invite-form"><p className="eyebrow">邀請同事</p><div><input type="email" inputMode="email" value={inviteEmail} onChange={(event) => setInviteEmail(event.target.value)} placeholder="同事電郵" /><select value={inviteRole} onChange={(event) => setInviteRole(event.target.value as Exclude<WorkspaceRole, "owner">)}><option value="member">一般成員</option><option value="viewer">只供查看</option>{workspace.role === "owner" && <option value="admin">管理員</option>}</select><button onClick={invite} disabled={busy}>邀請</button></div><small>一般成員可盤點及入貨；只供查看不可修改資料。</small></section>}<section className="workspace-form"><p className="eyebrow">另一間獨立店舖</p><div><input value={newName} onChange={(event) => setNewName(event.target.value)} placeholder="新店舖／倉庫名稱" /><button onClick={createAnother} disabled={busy}>建立</button></div></section>{message && <p className="form-message">{message}</p>}<button className="logout-button" onClick={() => supabase.auth.signOut()}>登出 {session.user.email}</button></section></div>;
}

function InboundExcelReviewPage({ review, items, setReview, confirmInbound, busy }: { review: Extract<ExcelReview, { kind: "inbound" }>; items: InventoryItem[]; setReview: (review: ExcelReview | null) => void; confirmInbound: () => void; busy: boolean }) {
  const update = (index: number, next: Partial<ExcelInboundLine>) => {
    const lines = [...review.lines]; lines[index] = { ...lines[index], ...next }; setReview({ ...review, lines });
  };
  const lineIssues = (line: ExcelInboundLine) => {
    const issues: string[] = [];
    if (!Number.isInteger(Number(line.quantity)) || Number(line.quantity) <= 0) issues.push("實收數量必須大過 0");
    if (!line.draft && !line.productId) issues.push("未選擇產品");
    if (line.draft) {
      const required: [keyof ProductDraft, string][] = [["category", "主分類"], ["subcategory", "子分類"], ["brand", "品牌"], ["flavor", "味道"], ["name", "產品名稱"], ["unit", "基本單位"]];
      const missing = required.filter(([key]) => !String(line.draft?.[key] ?? "").trim()).map(([, label]) => label);
      if (missing.length) issues.push(`未填：${missing.join("、")}`);
      if (!Number.isInteger(Number(line.draft.pack_size)) || line.draft.pack_size < 1) issues.push("每箱／包數量必須最少為 1");
    }
    return issues;
  };
  const identities = review.lines.map((line, index) => line.productId || (line.draft ? productIdentity(line.draft) : `missing:${index}`));
  const duplicate = new Set(identities).size !== identities.length;
  const problems = [
    ...(!review.lines.length ? ["Excel 入面未有可入貨項目"] : []),
    ...(duplicate ? ["有重複產品，請刪除重複項目或先合併數量"] : []),
    ...review.lines.flatMap((line, index) => lineIssues(line).map((issue) => `第 ${index + 1} 項：${issue}`)),
  ];
  const totalUnits = review.lines.reduce((total, line) => {
    const item = line.draft ?? items.find((candidate) => candidate.id === line.productId);
    return total + Number(line.quantity || 0) * (line.unitMode === "package" ? item?.pack_size ?? 0 : 1);
  }, 0);
  const invalidField = (value: unknown) => !String(value ?? "").trim() ? "field-invalid" : "";

  return <div className="review-page excel-review-page">
    <header className="review-topbar"><button onClick={() => setReview(null)}>← 取消</button><div><p className="eyebrow">未更新庫存</p><h2>Excel 入貨核對</h2></div><span>{review.lines.length} 項</span></header>
    <section className="review-summary">
      <div><span>上載檔案</span><strong>{review.filename}</strong></div>
      <label>訂單編號（選填）<input value={review.orderNumber} onChange={(event) => setReview({ ...review, orderNumber: event.target.value })} placeholder="留空亦可入貨" /><small>{review.orderNumber.trim() ? "已啟用同一訂單防重複檢查" : "如有填寫，系統會防止同一訂單重複入貨"}</small></label>
      <div className="review-totals"><span>入貨項目 <b>{review.lines.length}</b></span><span>預計新增 <b>{totalUnits}</b> 件</span></div>
      {problems.length > 0 && <div className="validation-banner"><strong>仲有 {problems.length} 項資料未完成</strong><ul>{problems.map((problem, index) => <li key={`${problem}-${index}`}>{problem}</li>)}</ul></div>}
      {!problems.length && <div className="validation-ready"><strong>✓ 資料齊全，可以確認入貨</strong></div>}
    </section>
    <section className="review-list"><div className="review-heading"><div><p className="eyebrow">自動配對結果</p><h3>產品及實收數量</h3></div></div>
      {review.lines.map((line, index) => {
        const item = line.draft ?? items.find((candidate) => candidate.id === line.productId);
        const issues = lineIssues(line);
        const updateDraft = (key: keyof ProductDraft, value: string | number) => line.draft && update(index, { draft: { ...line.draft, [key]: value } });
        return <article className={issues.length ? "review-item has-error" : "review-item is-ready"} key={`${line.rowNumber}-${index}`}>
          <div className="review-item-number">{index + 1}</div><div className="review-fields">
            {line.draft ? <div className={issues.length ? "generated-product has-error" : "generated-product is-ready"}>
              <div className="generated-product-title"><span>建立新產品</span><b>{issues.length ? `尚欠 ${issues.length} 項` : "資料齊全"}</b></div>
              <div className="two-fields"><label>主分類<input className={invalidField(line.draft.category)} value={line.draft.category} onChange={(event) => updateDraft("category", event.target.value)} /></label><label>子分類<input className={invalidField(line.draft.subcategory)} value={line.draft.subcategory} onChange={(event) => updateDraft("subcategory", event.target.value)} /></label></div>
              <div className="two-fields"><label>品牌<input className={invalidField(line.draft.brand)} value={line.draft.brand} onChange={(event) => updateDraft("brand", event.target.value)} /></label><label>味道<input className={invalidField(line.draft.flavor)} value={line.draft.flavor} onChange={(event) => updateDraft("flavor", event.target.value)} /></label></div>
              <label>產品名稱<input className={invalidField(line.draft.name)} value={line.draft.name} onChange={(event) => updateDraft("name", event.target.value)} /></label>
              <div className="three-fields"><label>規格<input value={line.draft.spec} onChange={(event) => updateDraft("spec", event.target.value)} /></label><label>基本單位<input className={invalidField(line.draft.unit)} value={line.draft.unit} onChange={(event) => updateDraft("unit", event.target.value)} /></label><label>每箱／包數量<input className={line.draft.pack_size < 1 ? "field-invalid" : ""} inputMode="numeric" value={line.draft.pack_size} onChange={(event) => updateDraft("pack_size", Number(event.target.value.replace(/\D/g, "")))} /></label></div>
              <button className="mapping-switch" onClick={() => update(index, { draft: undefined, productId: items[0]?.id ?? "", confidence: "suggested" })} disabled={!items.length}>改為配對現有產品</button>
            </div> : <div className="matched-product"><div><span className={line.confidence === "matched" ? "match-badge" : "match-badge suggested"}>{line.confidence === "matched" ? "已配對" : "可能配對 · 請核對"}</span><button onClick={() => update(index, { draft: { ...line.original }, productId: "", confidence: "new" })}>改為新產品</button></div><label>現有產品<select className={!line.productId ? "field-invalid" : ""} value={line.productId} onChange={(event) => update(index, { productId: event.target.value, confidence: "matched" })}>{items.map((product) => <option key={product.id} value={product.id}>{product.category}｜{product.subcategory}｜{product.brand}｜{product.flavor}｜{product.spec}</option>)}</select></label></div>}
            <div className="review-quantity"><label>實收數量<input className={!Number.isInteger(Number(line.quantity)) || Number(line.quantity) <= 0 ? "field-invalid" : ""} inputMode="numeric" value={line.quantity} onChange={(event) => { const value = event.target.value.replace(/\D/g, ""); update(index, { quantity: value === "" ? "" : Number(value) }); }} /></label><label>輸入單位<select value={line.unitMode} onChange={(event) => update(index, { unitMode: event.target.value as UnitMode })}><option value="package">箱／包</option><option value="base">{item?.unit ?? "件"}</option></select></label><div><span>自動換算</span><strong>{Number(line.quantity || 0) * (line.unitMode === "package" ? item?.pack_size ?? 0 : 1)} {item?.unit}</strong></div></div>
            {issues.length > 0 && <div className="line-validation">{issues.map((issue) => <span key={issue}>! {issue}</span>)}</div>}
          </div><button className="remove-button" onClick={() => setReview({ ...review, lines: review.lines.filter((_line, lineIndex) => lineIndex !== index) })}>×</button>
        </article>;
      })}
    </section>
    <footer className="review-footer"><div><span>{problems.length ? "請完成紅色提示項目" : "確認後先建立新產品，再批量入貨"}</span><strong>{problems.length ? `尚欠 ${problems.length} 項資料` : `${review.lines.length} 項 · ${totalUnits} 件`}</strong></div><button className="primary-button" onClick={confirmInbound} disabled={busy || problems.length > 0}>{busy ? "同步中…" : problems.length ? `未完成（${problems.length}）` : "確認全部入貨"}</button></footer>
  </div>;
}

function ExcelReviewPage({ review, items, setReview, confirmInbound, confirmStocktake, busy }: { review: ExcelReview; items: InventoryItem[]; setReview: (review: ExcelReview | null) => void; confirmInbound: () => void; confirmStocktake: () => void; busy: boolean }) {
  if (review.kind === "stocktake") {
    const update = (index: number, next: Partial<ExcelStocktakeLine>) => { const lines = [...review.lines]; lines[index] = { ...lines[index], ...next }; setReview({ ...review, lines }); };
    const updateQuantity = (index: number, item: InventoryItem | undefined, field: "packageQuantity" | "looseQuantity", raw: string) => {
      const value = raw.replace(/\D/g, "");
      const line = review.lines[index];
      const next = { ...line, [field]: value === "" ? "" : Number(value) };
      next.quantity = Number(next.packageQuantity || 0) * (item?.pack_size ?? 0) + Number(next.looseQuantity || 0);
      update(index, next);
    };
    const conflicts = review.lines.filter((line) => line.conflictQty !== undefined).length;
    const invalid = !review.lines.length || review.lines.some((line) => (line.packageQuantity === "" && line.looseQuantity === "") || !Number.isInteger(line.quantity) || line.quantity < 0);
    const acceptLatest = () => setReview({ ...review, lines: review.lines.map((line) => line.conflictQty === undefined ? line : { ...line, expectedQty: line.conflictQty, conflictQty: undefined }) });
    return <div className="review-page excel-review-page"><header className="review-topbar"><button onClick={() => setReview(null)}>← 取消</button><div><p className="eyebrow">未更新庫存</p><h2>Excel 盤點核對</h2></div><span>{review.lines.length} 項</span></header><section className="review-summary"><div><span>上載檔案</span><strong>{review.filename}</strong></div>{review.exportedAt && <small>匯出時間：{new Date(review.exportedAt).toLocaleString("zh-HK")}</small>}<div className="review-totals"><span>盤點項目 <b>{review.lines.length}</b></span><span className={conflicts ? "conflict-text" : ""}>資料衝突 <b>{conflicts}</b></span></div>{conflicts > 0 && <div className="conflict-banner"><strong>其他人喺匯出後更新過庫存</strong><p>逐項核對最新數量，再接受最新資料繼續。</p><button onClick={acceptLatest}>接受最新庫存資料</button></div>}</section><section className="review-list"><div className="review-heading"><div><p className="eyebrow">逐項確認</p><h3>整箱／整包 + 散件</h3></div></div>{review.lines.map((line, index) => { const item = items.find((candidate) => candidate.id === line.productId); return <article className={line.conflictQty === undefined ? "excel-review-row" : "excel-review-row has-conflict"} key={line.productId}><div className="review-item-number">{index + 1}</div><div><strong>{item?.brand} · {item?.flavor}</strong><p>{item?.name}｜{item?.spec}｜每箱／包 {item?.pack_size} {item?.unit}</p><div className="stocktake-compare"><span>匯出時 <b>{line.expectedQty}</b></span>{line.conflictQty !== undefined && <span className="conflict-text">而家 <b>{line.conflictQty}</b></span>}<label>箱／包數量<input inputMode="numeric" value={line.packageQuantity} onChange={(event) => updateQuantity(index, item, "packageQuantity", event.target.value)} /></label><label>散件數量<input inputMode="numeric" value={line.looseQuantity} onChange={(event) => updateQuantity(index, item, "looseQuantity", event.target.value)} /></label><span>換算總數 <b>{line.quantity} {item?.unit}</b></span></div></div><button className="remove-button" onClick={() => setReview({ ...review, lines: review.lines.filter((_line, lineIndex) => lineIndex !== index) })}>×</button></article>; })}</section><footer className="review-footer"><div><span>確認後記錄為今日 Stock Take</span><strong>{review.lines.length} 款產品</strong></div><button className="primary-button" onClick={confirmStocktake} disabled={busy || invalid || conflicts > 0}>{busy ? "同步中…" : conflicts ? "請先處理衝突" : invalid ? "請填寫盤點數量" : "確認全部盤點"}</button></footer></div>;
  }

  return <InboundExcelReviewPage review={review} items={items} setReview={setReview} confirmInbound={confirmInbound} busy={busy} />;
  /* Legacy inbound review retained temporarily for rollback reference.
  if (review.kind !== "inbound") return null;

  const update = (index: number, next: Partial<ExcelInboundLine>) => { const lines = [...review.lines]; lines[index] = { ...lines[index], ...next }; setReview({ ...review, lines }); };
  const invalid = !review.orderNumber.trim() || !review.lines.length || review.lines.some((line) => !Number.isInteger(Number(line.quantity)) || Number(line.quantity) <= 0 || (!line.draft && !line.productId) || (line.draft && (![line.draft.category, line.draft.subcategory, line.draft.brand, line.draft.flavor, line.draft.name, line.draft.unit].every((value) => value.trim()) || line.draft.pack_size < 1)));
  const identities = review.lines.map((line, index) => line.productId || (line.draft ? productIdentity(line.draft) : `missing:${index}`)); const duplicate = new Set(identities).size !== identities.length;
  const totalUnits = review.lines.reduce((total, line) => { const item = line.draft ?? items.find((candidate) => candidate.id === line.productId); return total + Number(line.quantity || 0) * (line.unitMode === "package" ? item?.pack_size ?? 0 : 1); }, 0);
      return <div className="review-page excel-review-page"><header className="review-topbar"><button onClick={() => setReview(null)}>← 取消</button><div><p className="eyebrow">未更新庫存</p><h2>Excel 入貨核對</h2></div><span>{review.lines.length} 項</span></header><section className="review-summary"><div><span>上載檔案</span><strong>{review.filename}</strong></div><label>訂單編號<input value={review.orderNumber} onChange={(event) => setReview({ ...review, orderNumber: event.target.value })} placeholder="必須填寫，用作防止重複入貨" /></label><div className="review-totals"><span>入貨項目 <b>{review.lines.length}</b></span><span>預計新增 <b>{totalUnits}</b> 件</span></div>{duplicate && <div className="conflict-banner"><strong>Excel 有重複產品</strong><p>請刪除重複項目，或者取消後合併數量再匯入。</p></div>}</section><section className="review-list"><div className="review-heading"><div><p className="eyebrow">自動配對結果</p><h3>產品及實收數量</h3></div></div>{review.lines.map((line, index) => { const item = line.draft ?? items.find((candidate) => candidate.id === line.productId); const updateDraft = (key: keyof ProductDraft, value: string | number) => line.draft && update(index, { draft: { ...line.draft, [key]: value } }); return <article className="review-item" key={`${line.rowNumber}-${index}`}><div className="review-item-number">{index + 1}</div><div className="review-fields">{line.draft ? <div className="generated-product"><div className="generated-product-title"><span>建立新產品</span><b>請核對</b></div><div className="two-fields"><label>主分類<input value={line.draft.category} onChange={(event) => updateDraft("category", event.target.value)} /></label><label>子分類<input value={line.draft.subcategory} onChange={(event) => updateDraft("subcategory", event.target.value)} /></label></div><div className="two-fields"><label>品牌<input value={line.draft.brand} onChange={(event) => updateDraft("brand", event.target.value)} /></label><label>味道<input value={line.draft.flavor} onChange={(event) => updateDraft("flavor", event.target.value)} /></label></div><label>產品名稱<input value={line.draft.name} onChange={(event) => updateDraft("name", event.target.value)} /></label><div className="three-fields"><label>規格<input value={line.draft.spec} onChange={(event) => updateDraft("spec", event.target.value)} /></label><label>基本單位<input value={line.draft.unit} onChange={(event) => updateDraft("unit", event.target.value)} /></label><label>每箱／包數量<input inputMode="numeric" value={line.draft.pack_size} onChange={(event) => updateDraft("pack_size", Math.max(1, Number(event.target.value.replace(/\D/g, ""))))} /></label></div><button className="mapping-switch" onClick={() => update(index, { draft: undefined, productId: items[0]?.id ?? "", confidence: "suggested" })} disabled={!items.length}>改為配對現有產品</button></div> : <div className="matched-product"><div><span className={line.confidence === "matched" ? "match-badge" : "match-badge suggested"}>{line.confidence === "matched" ? "已配對" : "可能配對 · 請核對"}</span><button onClick={() => update(index, { draft: { ...line.original }, productId: "", confidence: "new" })}>改為新產品</button></div><label>現有產品<select value={line.productId} onChange={(event) => update(index, { productId: event.target.value, confidence: "matched" })}>{items.map((product) => <option key={product.id} value={product.id}>{product.category}｜{product.subcategory}｜{product.brand}｜{product.flavor}｜{product.spec}</option>)}</select></label></div>}<div className="review-quantity"><label>實收數量<input inputMode="numeric" value={line.quantity} onChange={(event) => { const value = event.target.value.replace(/\D/g, ""); update(index, { quantity: value === "" ? "" : Number(value) }); }} /></label><label>輸入單位<select value={line.unitMode} onChange={(event) => update(index, { unitMode: event.target.value as UnitMode })}><option value="package">箱／包</option><option value="base">{item?.unit ?? "件"}</option></select></label><div><span>自動換算</span><strong>{Number(line.quantity || 0) * (line.unitMode === "package" ? item?.pack_size ?? 0 : 1)} {item?.unit}</strong></div></div></div><button className="remove-button" onClick={() => setReview({ ...review, lines: review.lines.filter((_line, lineIndex) => lineIndex !== index) })}>×</button></article>; })}</section><footer className="review-footer"><div><span>確認後先建立新產品，再批量入貨</span><strong>{review.lines.length} 項 · {totalUnits} 件</strong></div><button className="primary-button" onClick={confirmInbound} disabled={busy || invalid || duplicate}>{busy ? "同步中…" : duplicate ? "請先處理重複產品" : "確認全部入貨"}</button></footer></div>;
  */
}

function UploadReview({ pdf, items, setPdf, confirm, busy }: { pdf: { filename: string; orderNumber: string; lines: PdfLine[] }; items: InventoryItem[]; setPdf: (value: typeof pdf | null) => void; confirm: () => void; busy: boolean }) {
  const lineProduct = (line: PdfLine) => line.draft ?? items.find((entry) => entry.id === line.productId);
  const totalUnits = pdf.lines.reduce((sum, line) => { const item = lineProduct(line); const quantity = Number(line.pieces || 0); return sum + (line.unitMode === "package" ? quantity * (item?.pack_size ?? 0) : quantity); }, 0);
  const updateLine = (index: number, next: Partial<PdfLine>) => { const lines = [...pdf.lines]; lines[index] = { ...lines[index], ...next }; setPdf({ ...pdf, lines }); };
  const updateDraft = (index: number, key: keyof ProductDraft, value: string | number) => {
    const line = pdf.lines[index]; if (!line.draft) return;
    updateLine(index, { draft: { ...line.draft, [key]: value } });
  };
  const removeLine = (index: number) => setPdf({ ...pdf, lines: pdf.lines.filter((_line, lineIndex) => lineIndex !== index) });
  const addLine = () => setPdf({ ...pdf, lines: [...pdf.lines, items[0]
    ? { productId: items[0].id, pieces: 1, unitMode: "package" }
    : { productId: "", pieces: 1, unitMode: "package", draft: { category: "其他", subcategory: "未分類", brand: "", flavor: "原味", name: "", spec: "", unit: "件", pack_size: 1, low_stock_level: 0 } }] });
  const invalid = pdf.lines.some((line) => Number(line.pieces) <= 0 || (!line.draft && !line.productId) || (line.draft && (![line.draft.category, line.draft.subcategory, line.draft.brand, line.draft.flavor, line.draft.name, line.draft.unit].every((value) => value.trim()) || line.draft.pack_size < 1)));
  return <div className="review-page">
    <header className="review-topbar"><button onClick={() => setPdf(null)}>← 取消</button><div><p className="eyebrow">未更新庫存</p><h2>資料核對</h2></div><span>{pdf.lines.length} 項</span></header>
    <section className="review-summary"><div><span>上載檔案</span><strong>{pdf.filename}</strong></div><label>訂單編號<input value={pdf.orderNumber} onChange={(event) => setPdf({ ...pdf, orderNumber: event.target.value })} placeholder="如有訂單編號請填寫" /></label><div className="review-totals"><span>辨認項目 <b>{pdf.lines.length}</b></span><span>預計新增 <b>{totalUnits}</b> 件</span></div></section>
    <section className="review-list"><div className="review-heading"><div><p className="eyebrow">逐項確認</p><h3>產品及數量</h3></div><button className="outline-button" onClick={addLine}>＋ 加漏咗嘅貨</button></div>
      {!pdf.lines.length && <div className="empty-card"><strong>未辨認到產品</strong><p>按「加漏咗嘅貨」手動加入，再確認入庫。</p></div>}
      {pdf.lines.map((line, index) => { const item = lineProduct(line); const quantity = Number(line.pieces || 0); const converted = line.unitMode === "package" ? quantity * (item?.pack_size ?? 0) : quantity; return <article className="review-item" key={`${index}-${line.productId}`}><div className="review-item-number">{index + 1}</div><div className="review-fields">{line.draft ? <div className="generated-product"><div className="generated-product-title"><span>PDF 自動建立新產品</span><b>請核對</b></div><div className="two-fields"><label>主分類<input value={line.draft.category} onChange={(event) => updateDraft(index, "category", event.target.value)} /></label><label>子分類<input value={line.draft.subcategory} onChange={(event) => updateDraft(index, "subcategory", event.target.value)} /></label></div><div className="two-fields"><label>品牌<input value={line.draft.brand} onChange={(event) => updateDraft(index, "brand", event.target.value)} /></label><label>味道<input value={line.draft.flavor} onChange={(event) => updateDraft(index, "flavor", event.target.value)} /></label></div><label>產品名稱<input value={line.draft.name} onChange={(event) => updateDraft(index, "name", event.target.value)} /></label><div className="three-fields"><label>規格<input value={line.draft.spec} onChange={(event) => updateDraft(index, "spec", event.target.value)} /></label><label>基本單位<input value={line.draft.unit} onChange={(event) => updateDraft(index, "unit", event.target.value)} /></label><label>每箱／包數量<input inputMode="numeric" value={line.draft.pack_size} onChange={(event) => updateDraft(index, "pack_size", Math.max(1, Number(event.target.value.replace(/\D/g, ""))))} /></label></div></div> : <label>現有產品<select value={line.productId} onChange={(event) => updateLine(index, { productId: event.target.value })}>{items.map((entry) => <option key={entry.id} value={entry.id}>{entry.category}｜{entry.subcategory}｜{entry.brand}｜{entry.flavor}</option>)}</select></label>}<div className="review-quantity"><label>數量<input inputMode="numeric" value={line.pieces} onChange={(event) => { const value = event.target.value.replace(/\D/g, ""); updateLine(index, { pieces: value === "" ? "" : Number(value) }); }} /></label><label>輸入單位<select value={line.unitMode} onChange={(event) => updateLine(index, { unitMode: event.target.value as UnitMode })}><option value="package">箱／包</option><option value="base">{item?.unit ?? "件"}</option></select></label><div><span>自動換算</span><strong>{converted} {item?.unit}</strong></div></div></div><button className="remove-button" onClick={() => removeLine(index)} aria-label="刪除項目">×</button></article>; })}
    </section>
    <footer className="review-footer"><div><span>確認後先建立新產品，再更新共享 Database</span><strong>{pdf.lines.length} 項 · {totalUnits} 件</strong></div><button className="primary-button" onClick={confirm} disabled={busy || !pdf.lines.length || invalid}>{busy ? "同步中…" : "確認全部入庫"}</button></footer>
  </div>;
}
