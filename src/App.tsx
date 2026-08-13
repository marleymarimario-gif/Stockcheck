import { useEffect, useMemo, useRef, useState } from "react";
import type { Session } from "@supabase/supabase-js";
import { isConfigured, supabase } from "./supabase";

type InventoryItem = {
  id: string; category: string; brand: string; flavor: string; name: string;
  spec: string; unit: string; pack_size: number; current_qty: number;
  low_stock_level: number; stocktake_date: string | null; counted_by_email: string | null;
};
type Activity = { kind: string; product_name: string; quantity: number; actor: string; happened_at: string };
type Tab = "count" | "stock" | "inbound" | "activity";
type UnitMode = "package" | "base";
type PdfLine = { productId: string; pieces: number; unitMode: UnitMode };
type NewProduct = {
  category: string; brand: string; flavor: string; name: string; spec: string;
  unit: string; packSize: string; initialPieces: string; lowStockLevel: string;
};

const today = () => new Date().toLocaleDateString("en-CA", { timeZone: "Asia/Hong_Kong" });
const publisherId = import.meta.env.VITE_ADSENSE_PUBLISHER_ID ?? "";

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

  useEffect(() => {
    supabase.auth.getSession().then(({ data }) => { setSession(data.session); setChecking(false); });
    const { data } = supabase.auth.onAuthStateChange((_event, next) => setSession(next));
    return () => data.subscription.unsubscribe();
  }, []);

  if (checking) return <main className="center-screen"><div className="spinner" /><p>連接共享庫存…</p></main>;
  if (!isConfigured) return <SetupNotice />;
  if (!session) return <PublicHome />;
  return <Stockcheck session={session} />;
}

function SetupNotice() {
  return <main className="public-shell"><section className="hero-card"><div className="app-mark">倉</div><p className="eyebrow">等待連接</p><h1>倉點 <span>Stockcheck</span></h1><p>網站介面已準備好，完成 Supabase Project 連接後即可開始多人共用。</p><div className="status-note">管理員設定中，毋須使用者輸入任何技術資料。</div></section></main>;
}

function PublicHome() {
  const [email, setEmail] = useState("");
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState("");
  const [privacy, setPrivacy] = useState(false);

  const signIn = async () => {
    if (!email.includes("@")) return setMessage("請輸入已獲邀請嘅電郵地址");
    setBusy(true);
    const redirectTo = `${location.origin}${import.meta.env.BASE_URL}`;
    const { error } = await supabase.auth.signInWithOtp({ email, options: { shouldCreateUser: false, emailRedirectTo: redirectTo } });
    setBusy(false);
    setMessage(error ? "呢個電郵未獲授權，請聯絡管理員。" : "登入連結已寄出，請檢查電郵。 ");
  };

  return <main className="public-shell">
    <section className="hero-card">
      <div className="app-mark">倉</div><p className="eyebrow">手機共享庫存</p>
      <h1>倉點 <span>Stockcheck</span></h1>
      <p>團隊用同一份雲端資料，每日盤點、入貨、按種類查看庫存，任何電話都保持同步。</p>
      <div className="feature-grid"><span>✓ 每日 Stock Take</span><span>✓ 新產品及入貨</span><span>✓ PDF 本機辨認</span><span>✓ 操作記錄</span></div>
      <label className="login-field">已獲邀請電郵<input type="email" inputMode="email" value={email} onChange={(e) => setEmail(e.target.value)} placeholder="name@example.com" /></label>
      <button className="primary-button" onClick={signIn} disabled={busy}>{busy ? "寄出中…" : "寄出安全登入連結"}</button>
      {message && <p className="form-message">{message}</p>}
      <button className="text-button" onClick={() => setPrivacy(true)}>私隱政策</button>
    </section>
    {privacy && <PrivacyDialog close={() => setPrivacy(false)} />}
  </main>;
}

function PrivacyDialog({ close }: { close: () => void }) {
  return <div className="modal-backdrop"><section className="modal privacy-modal"><div className="modal-head"><div><p className="eyebrow">Privacy</p><h2>私隱政策</h2></div><button onClick={close}>關閉</button></div><p>倉點只儲存獲授權使用者的電郵、產品資料、盤點與入貨記錄。訂單 PDF 只在使用者裝置讀取，原檔不會上傳。</p><p>網站使用 Supabase 提供登入及共享資料庫，並可能使用 Google AdSense 顯示廣告。Google 可能按其政策使用 Cookie 或類似技術提供及量度廣告。</p><p>如要查閱或刪除帳戶資料，請聯絡網站管理員。使用本網站代表同意上述資料處理。</p></section></div>;
}

function Stockcheck({ session }: { session: Session }) {
  const [items, setItems] = useState<InventoryItem[]>([]);
  const [activity, setActivity] = useState<Activity[]>([]);
  const [tab, setTab] = useState<Tab>("count");
  const [query, setQuery] = useState("");
  const [expanded, setExpanded] = useState<string | null>(null);
  const [counts, setCounts] = useState<Record<string, string>>({});
  const [countUnits, setCountUnits] = useState<Record<string, UnitMode>>({});
  const [busy, setBusy] = useState<string | null>(null);
  const [toast, setToast] = useState("");
  const [stockIn, setStockIn] = useState<{ productId: string; pieces: string; source: string; unitMode: UnitMode }>({ productId: "", pieces: "1", source: "手動入貨", unitMode: "package" });
  const [showNewProduct, setShowNewProduct] = useState(false);
  const [pdf, setPdf] = useState<{ filename: string; orderNumber: string; lines: PdfLine[] } | null>(null);
  const [pdfBusy, setPdfBusy] = useState(false);
  const fileRef = useRef<HTMLInputElement>(null);

  const refresh = async () => {
    const [{ data: stock, error: stockError }, { data: events, error: eventError }] = await Promise.all([
      supabase.from("inventory_current").select("*").order("sort_order"),
      supabase.from("recent_activity").select("*").order("happened_at", { ascending: false }).limit(30),
    ]);
    if (stockError || eventError) throw new Error(stockError?.message ?? eventError?.message ?? "未能載入共享庫存");
    const next = (stock ?? []) as InventoryItem[];
    setItems(next); setActivity((events ?? []) as Activity[]);
    if (!stockIn.productId && next[0]) setStockIn((value) => ({ ...value, productId: next[0].id }));
  };

  useEffect(() => { refresh().catch(() => setToast("未能載入共享庫存，請稍後再試")); }, []);
  useEffect(() => { if (!toast) return; const timer = setTimeout(() => setToast(""), 3000); return () => clearTimeout(timer); }, [toast]);

  const filtered = useMemo(() => {
    const needle = query.trim().toLowerCase();
    return needle ? items.filter((item) => [item.brand, item.flavor, item.name, item.category].join(" ").toLowerCase().includes(needle)) : items;
  }, [items, query]);
  const groups = useMemo(() => {
    const map = new Map<string, InventoryItem[]>();
    filtered.forEach((item) => map.set(item.category, [...(map.get(item.category) ?? []), item]));
    return [...map.entries()];
  }, [filtered]);
  const doneToday = items.filter((item) => item.stocktake_date === today()).length;
  const lowStock = items.filter((item) => item.current_qty <= item.low_stock_level).length;

  const saveCount = async (item: InventoryItem) => {
    const enteredQuantity = Number(counts[item.id]); const unitMode = countUnits[item.id] ?? "base";
    const quantity = unitMode === "package" ? enteredQuantity * item.pack_size : enteredQuantity;
    if (!Number.isInteger(enteredQuantity) || enteredQuantity < 0) return setToast("請輸入實際點到嘅數量");
    setBusy(item.id);
    const { error } = await supabase.from("stocktakes").insert({ product_id: item.id, quantity, entered_quantity: enteredQuantity, entered_unit: unitMode === "package" ? "箱／包" : item.unit, stocktake_date: today(), counted_by: session.user.id, counted_by_email: session.user.email });
    setBusy(null); if (error) return setToast("未能儲存盤點");
    setCounts((value) => ({ ...value, [item.id]: "" })); setToast(`${item.brand} ${item.flavor} 已完成盤點`); await refresh();
  };

  const saveInbound = async () => {
    const enteredQuantity = Number(stockIn.pieces); const item = items.find((entry) => entry.id === stockIn.productId);
    if (!item || !Number.isInteger(enteredQuantity) || enteredQuantity <= 0) return setToast("請輸入新增數量");
    const unitsAdded = stockIn.unitMode === "package" ? enteredQuantity * item.pack_size : enteredQuantity;
    setBusy("inbound");
    const { error } = await supabase.from("stock_ins").insert({ product_id: item.id, pieces: stockIn.unitMode === "package" ? enteredQuantity : 1, units_added: unitsAdded, entered_quantity: enteredQuantity, entered_unit: stockIn.unitMode === "package" ? "箱／包" : item.unit, source: stockIn.source, added_by: session.user.id, added_by_email: session.user.email });
    setBusy(null); if (error) return setToast("未能新增入貨");
    setStockIn((value) => ({ ...value, pieces: "1" })); setToast("入貨已同步到所有裝置"); await refresh();
  };

  const handlePdf = async (file?: File) => {
    if (!file) return; setPdfBusy(true);
    try {
      const pdfjs = await import("pdfjs-dist/legacy/build/pdf.mjs");
      pdfjs.GlobalWorkerOptions.workerSrc = new URL("pdfjs-dist/legacy/build/pdf.worker.min.mjs", import.meta.url).toString();
      const document = await pdfjs.getDocument({ data: new Uint8Array(await file.arrayBuffer()) }).promise;
      let text = "";
      for (let pageNo = 1; pageNo <= document.numPages; pageNo++) {
        const content = await (await document.getPage(pageNo)).getTextContent();
        text += " " + content.items.map((part) => "str" in part ? part.str : "").join(" ");
      }
      const normalized = text.replace(/\s+/g, "").toLowerCase();
      const matches = items.filter((item) => normalized.includes(item.brand.replace(/\s+/g, "").toLowerCase()) && normalized.includes(item.flavor.replace(/\s+/g, "").toLowerCase()));
      setPdf({ filename: file.name, orderNumber: text.match(/H\d{12}/)?.[0] ?? "", lines: matches.map((item) => ({ productId: item.id, pieces: 1, unitMode: "package" })) });
      setToast(matches.length ? `已辨認 ${matches.length} 款，請核對件數` : "未能自動配對，請改用手動入貨");
    } catch { setToast("未能讀取呢份 PDF"); }
    finally { setPdfBusy(false); if (fileRef.current) fileRef.current.value = ""; }
  };

  const confirmPdf = async () => {
    if (!pdf?.lines.length) return; setBusy("pdf");
    const rows = pdf.lines.filter((line) => line.pieces > 0).map((line) => {
      const item = items.find((entry) => entry.id === line.productId)!;
      const unitsAdded = line.unitMode === "package" ? line.pieces * item.pack_size : line.pieces;
      return { product_id: item.id, pieces: line.unitMode === "package" ? line.pieces : 1, units_added: unitsAdded, entered_quantity: line.pieces, entered_unit: line.unitMode === "package" ? "箱／包" : item.unit, source: `PDF: ${pdf.filename}`, order_number: pdf.orderNumber || null, added_by: session.user.id, added_by_email: session.user.email };
    });
    const { error } = await supabase.from("stock_ins").insert(rows);
    setBusy(null); if (error) return setToast(error.code === "23505" ? "呢張訂單已經入過貨" : "未能確認 PDF 入貨");
    setPdf(null); setToast("PDF 入貨已同步到所有裝置"); await refresh();
  };

  return <main className="app-shell">
    <header className="topbar"><div><p className="eyebrow">共享庫存</p><h1>倉點 <span>Stockcheck</span></h1></div><button className="avatar" title={session.user.email} onClick={() => supabase.auth.signOut()}>{(session.user.email ?? "U").slice(0, 1).toUpperCase()}</button></header>
    <section className="summary-card"><div><span>今日盤點</span><strong>{doneToday}<small> / {items.length}</small></strong></div><div className="progress"><i style={{ width: `${items.length ? doneToday / items.length * 100 : 0}%` }} /></div><div className="summary-row"><span>{today()}</span><span className={lowStock ? "warning" : "good"}>{lowStock ? `${lowStock} 款低存量` : "庫存正常"}</span></div></section>
    {(tab === "count" || tab === "stock") && <label className="search"><span>⌕</span><input value={query} onChange={(event) => setQuery(event.target.value)} placeholder="搜尋品牌、味道或產品" /></label>}

    {tab === "count" && <section className="content-section"><div className="section-heading"><div><p className="eyebrow">按種類排列</p><h2>每日盤點</h2></div><span>{items.length - doneToday} 款未完成</span></div>{!items.length && <EmptyProducts open={() => { setTab("inbound"); setShowNewProduct(true); }} />}<div className="category-list">{groups.map(([category, products]) => { const complete = products.filter((item) => item.stocktake_date === today()).length; const open = expanded === category || Boolean(query); return <article className="category" key={category}><button className="category-head" onClick={() => setExpanded(open && !query ? null : category)}><span className="category-icon">{category.slice(0, 1)}</span><span><strong>{category}</strong><small>{products.length} 款產品</small></span><span className={complete === products.length ? "done-pill" : "count-pill"}>{complete}/{products.length}</span><b>{open ? "−" : "+"}</b></button>{open && <div className="product-list">{products.map((item) => <ProductCountCard key={item.id} item={item} value={counts[item.id] ?? ""} unitMode={countUnits[item.id] ?? "base"} onUnitChange={(unitMode) => setCountUnits((all) => ({ ...all, [item.id]: unitMode }))} onChange={(value) => setCounts((all) => ({ ...all, [item.id]: value }))} onSave={() => saveCount(item)} busy={busy === item.id} />)}</div>}</article>; })}</div></section>}

    {tab === "stock" && <section className="content-section"><div className="section-heading"><div><p className="eyebrow">即時共享</p><h2>庫存清單</h2></div><span>{filtered.length} 款</span></div><div className="stock-list">{groups.map(([category, products]) => <section key={category}><h3>{category}</h3>{products.map((item) => <div className="stock-row" key={item.id}><div><strong>{item.brand} · {item.flavor}</strong><span>{item.name}｜{item.spec}</span></div><div className={item.current_qty <= item.low_stock_level ? "qty low" : "qty"}><strong>{item.current_qty}</strong><small>{item.unit}</small></div></div>)}</section>)}</div></section>}

    {tab === "inbound" && <section className="content-section"><div className="section-heading"><div><p className="eyebrow">增加庫存</p><h2>新貨入庫</h2></div><button className="outline-button" onClick={() => setShowNewProduct(true)}>＋ 新增產品</button></div><div className="form-card"><label>現有產品<select value={stockIn.productId} onChange={(event) => setStockIn({ ...stockIn, productId: event.target.value })}><option value="">請選擇</option>{items.map((item) => <option value={item.id} key={item.id}>{item.category}｜{item.brand}｜{item.flavor}</option>)}</select></label><div className="quantity-unit-row"><label>新增數量<input inputMode="numeric" value={stockIn.pieces} onChange={(event) => setStockIn({ ...stockIn, pieces: event.target.value.replace(/\D/g, "") })} /></label><label>輸入單位<select value={stockIn.unitMode} onChange={(event) => setStockIn({ ...stockIn, unitMode: event.target.value as UnitMode })}><option value="package">箱／包</option><option value="base">{items.find((item) => item.id === stockIn.productId)?.unit ?? "件"}</option></select></label></div>{stockIn.productId && <div className="conversion-note">自動換算：<strong>{stockIn.unitMode === "package" ? Number(stockIn.pieces || 0) * (items.find((item) => item.id === stockIn.productId)?.pack_size ?? 0) : Number(stockIn.pieces || 0)}</strong> {items.find((item) => item.id === stockIn.productId)?.unit}</div>}<label>來源<input value={stockIn.source} onChange={(event) => setStockIn({ ...stockIn, source: event.target.value })} /></label><button className="primary-button" onClick={saveInbound} disabled={busy === "inbound"}>{busy === "inbound" ? "儲存中…" : "確認入貨"}</button></div><div className="pdf-card"><div className="pdf-icon">PDF</div><div><strong>從訂單 PDF 辨認</strong><p>完成後會先進入資料核對頁，未確認唔會改庫存。</p></div><button onClick={() => fileRef.current?.click()} disabled={pdfBusy}>{pdfBusy ? "讀取中" : "選擇 PDF"}</button><input ref={fileRef} hidden type="file" accept="application/pdf" onChange={(event) => handlePdf(event.target.files?.[0])} /></div></section>}

    {tab === "activity" && <section className="content-section"><div className="section-heading"><div><p className="eyebrow">可追查記錄</p><h2>最近操作</h2></div></div><div className="activity-list">{activity.length ? activity.map((entry, index) => <div className="activity-row" key={`${entry.happened_at}-${index}`}><span className={entry.kind === "盤點" ? "activity-icon count" : "activity-icon inbound"}>{entry.kind === "盤點" ? "✓" : "+"}</span><div><strong>{entry.product_name}</strong><p>{entry.actor} · {new Date(entry.happened_at).toLocaleString("zh-HK")}</p></div><b>{entry.kind === "盤點" ? entry.quantity : `+${entry.quantity}`}</b></div>) : <div className="empty">未有操作記錄</div>}</div></section>}

    <div className="ad-safe-gap" aria-label="Google 廣告安全區" />
    <nav className="bottom-nav">{([["count","盤點","✓"],["stock","庫存","▦"],["inbound","入貨","＋"],["activity","記錄","◷"]] as [Tab,string,string][]).map(([id,label,icon]) => <button key={id} className={tab === id ? "active" : ""} onClick={() => setTab(id)}><span>{icon}</span>{label}</button>)}</nav>
    {showNewProduct && <NewProductDialog session={session} close={() => setShowNewProduct(false)} saved={async () => { setShowNewProduct(false); setToast("新產品已加入共享清單"); await refresh(); }} />}
    {pdf && <UploadReview pdf={pdf} items={items} setPdf={setPdf} confirm={confirmPdf} busy={busy === "pdf"} />}
    {toast && <div className="toast">{toast}</div>}
  </main>;
}

function EmptyProducts({ open }: { open: () => void }) { return <div className="empty-card"><strong>未有產品</strong><p>先新增第一樣貨，之後所有裝置都會同步見到。</p><button className="primary-button" onClick={open}>新增產品</button></div>; }

function ProductCountCard({ item, value, unitMode, onUnitChange, onChange, onSave, busy }: { item: InventoryItem; value: string; unitMode: UnitMode; onUnitChange: (v: UnitMode) => void; onChange: (v: string) => void; onSave: () => void; busy: boolean }) {
  const done = item.stocktake_date === today();
  const converted = unitMode === "package" ? Number(value || 0) * item.pack_size : Number(value || 0);
  return <div className={done ? "product-card complete" : "product-card"}><div className="product-copy"><div><strong>{item.brand}</strong><span>{item.flavor}</span></div><p>{item.name} · {item.spec}</p><small>{done ? `${item.counted_by_email} 今日已盤點` : `上次：${item.stocktake_date ?? "未盤點"}`}</small></div><div className="count-area"><div className="count-control"><label><input inputMode="numeric" pattern="[0-9]*" placeholder={unitMode === "base" ? String(item.current_qty) : "0"} value={value} onChange={(event) => onChange(event.target.value.replace(/\D/g, ""))} /><select aria-label="盤點單位" value={unitMode} onChange={(event) => onUnitChange(event.target.value as UnitMode)}><option value="base">{item.unit}</option><option value="package">箱／包</option></select></label><button onClick={onSave} disabled={busy}>{busy ? "…" : done ? "更新" : "完成"}</button></div>{value && <small className="inline-conversion">＝ {converted} {item.unit}</small>}</div></div>;
}

function NewProductDialog({ session, close, saved }: { session: Session; close: () => void; saved: () => Promise<void> }) {
  const [form, setForm] = useState<NewProduct>({ category: "", brand: "", flavor: "", name: "", spec: "", unit: "件", packSize: "1", initialPieces: "1", lowStockLevel: "0" });
  const [busy, setBusy] = useState(false); const [error, setError] = useState("");
  const change = (key: keyof NewProduct, value: string) => setForm((all) => ({ ...all, [key]: value }));
  const save = async () => {
    const packSize = Number(form.packSize); const initialPieces = Number(form.initialPieces); const low = Number(form.lowStockLevel);
    if (![form.category, form.brand, form.flavor, form.name].every((v) => v.trim()) || !Number.isInteger(packSize) || packSize < 1 || !Number.isInteger(initialPieces) || initialPieces < 0 || !Number.isInteger(low) || low < 0) return setError("請填妥產品資料及正確數量");
    setBusy(true);
    const { data, error: productError } = await supabase.from("products").insert({ category: form.category.trim(), brand: form.brand.trim(), flavor: form.flavor.trim(), name: form.name.trim(), spec: form.spec.trim(), unit: form.unit.trim() || "件", pack_size: packSize, low_stock_level: low, created_by: session.user.id }).select("id").single();
    if (productError || !data) { setBusy(false); return setError("未能新增產品"); }
    if (initialPieces > 0) {
      const { error: stockError } = await supabase.from("stock_ins").insert({ product_id: data.id, pieces: initialPieces, units_added: initialPieces * packSize, entered_quantity: initialPieces, entered_unit: "箱／包", source: "首次入貨", added_by: session.user.id, added_by_email: session.user.email });
      if (stockError) { setBusy(false); return setError("產品已建立，但首次入貨未能儲存"); }
    }
    setBusy(false); await saved();
  };
  return <div className="modal-backdrop"><section className="modal"><div className="modal-head"><div><p className="eyebrow">共享產品目錄</p><h2>新增產品</h2></div><button onClick={close}>取消</button></div><div className="modal-form"><label>種類<input value={form.category} onChange={(e) => change("category", e.target.value)} placeholder="例如：薯片／脆片" /></label><div className="two-fields"><label>品牌<input value={form.brand} onChange={(e) => change("brand", e.target.value)} /></label><label>味道<input value={form.flavor} onChange={(e) => change("flavor", e.target.value)} /></label></div><label>產品名稱<input value={form.name} onChange={(e) => change("name", e.target.value)} /></label><div className="two-fields"><label>規格<input value={form.spec} onChange={(e) => change("spec", e.target.value)} placeholder="例如 25g x 30" /></label><label>盤點單位<input value={form.unit} onChange={(e) => change("unit", e.target.value)} placeholder="小包" /></label></div><div className="three-fields"><label>每箱／包件數<input inputMode="numeric" value={form.packSize} onChange={(e) => change("packSize", e.target.value.replace(/\D/g, ""))} /></label><label>首次箱／包數<input inputMode="numeric" value={form.initialPieces} onChange={(e) => change("initialPieces", e.target.value.replace(/\D/g, ""))} /></label><label>低存量警示<input inputMode="numeric" value={form.lowStockLevel} onChange={(e) => change("lowStockLevel", e.target.value.replace(/\D/g, ""))} /></label></div>{error && <p className="form-message error">{error}</p>}<button className="primary-button" onClick={save} disabled={busy}>{busy ? "儲存中…" : "建立並加入首次入貨"}</button></div></section></div>;
}

function UploadReview({ pdf, items, setPdf, confirm, busy }: { pdf: { filename: string; orderNumber: string; lines: PdfLine[] }; items: InventoryItem[]; setPdf: (value: typeof pdf | null) => void; confirm: () => void; busy: boolean }) {
  const totalUnits = pdf.lines.reduce((sum, line) => { const item = items.find((entry) => entry.id === line.productId); return sum + (line.unitMode === "package" ? line.pieces * (item?.pack_size ?? 0) : line.pieces); }, 0);
  const updateLine = (index: number, next: Partial<PdfLine>) => { const lines = [...pdf.lines]; lines[index] = { ...lines[index], ...next }; setPdf({ ...pdf, lines }); };
  const removeLine = (index: number) => setPdf({ ...pdf, lines: pdf.lines.filter((_line, lineIndex) => lineIndex !== index) });
  const addLine = () => { if (!items[0]) return; setPdf({ ...pdf, lines: [...pdf.lines, { productId: items[0].id, pieces: 1, unitMode: "package" }] }); };
  return <div className="review-page">
    <header className="review-topbar"><button onClick={() => setPdf(null)}>← 取消</button><div><p className="eyebrow">未更新庫存</p><h2>資料核對</h2></div><span>{pdf.lines.length} 項</span></header>
    <section className="review-summary"><div><span>PDF 檔案</span><strong>{pdf.filename}</strong></div><label>訂單編號<input value={pdf.orderNumber} onChange={(event) => setPdf({ ...pdf, orderNumber: event.target.value })} placeholder="如有訂單編號請填寫" /></label><div className="review-totals"><span>辨認項目 <b>{pdf.lines.length}</b></span><span>預計新增 <b>{totalUnits}</b> 件</span></div></section>
    <section className="review-list"><div className="review-heading"><div><p className="eyebrow">逐項確認</p><h3>產品及數量</h3></div><button className="outline-button" onClick={addLine}>＋ 加漏咗嘅貨</button></div>
      {!pdf.lines.length && <div className="empty-card"><strong>未辨認到產品</strong><p>按「加漏咗嘅貨」手動加入，再確認入庫。</p></div>}
      {pdf.lines.map((line, index) => { const item = items.find((entry) => entry.id === line.productId); const converted = line.unitMode === "package" ? line.pieces * (item?.pack_size ?? 0) : line.pieces; return <article className="review-item" key={`${index}-${line.productId}`}><div className="review-item-number">{index + 1}</div><div className="review-fields"><label>產品<select value={line.productId} onChange={(event) => updateLine(index, { productId: event.target.value })}>{items.map((entry) => <option key={entry.id} value={entry.id}>{entry.category}｜{entry.brand}｜{entry.flavor}</option>)}</select></label><div className="review-quantity"><label>數量<input inputMode="numeric" value={line.pieces} onChange={(event) => updateLine(index, { pieces: Math.max(0, Number(event.target.value.replace(/\D/g, ""))) })} /></label><label>輸入單位<select value={line.unitMode} onChange={(event) => updateLine(index, { unitMode: event.target.value as UnitMode })}><option value="package">箱／包</option><option value="base">{item?.unit ?? "件"}</option></select></label><div><span>自動換算</span><strong>{converted} {item?.unit}</strong></div></div></div><button className="remove-button" onClick={() => removeLine(index)} aria-label="刪除項目">×</button></article>; })}
    </section>
    <footer className="review-footer"><div><span>確認後更新共享 Database</span><strong>{pdf.lines.length} 項 · {totalUnits} 件</strong></div><button className="primary-button" onClick={confirm} disabled={busy || !pdf.lines.length || pdf.lines.some((line) => line.pieces <= 0)}>{busy ? "同步中…" : "確認全部入庫"}</button></footer>
  </div>;
}
