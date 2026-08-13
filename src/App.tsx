import { useEffect, useMemo, useRef, useState } from "react";
import type { Session } from "@supabase/supabase-js";
import { isConfigured, supabase } from "./supabase";

type InventoryItem = {
  id: string; category: string; brand: string; flavor: string; name: string;
  spec: string; unit: string; pack_size: number; current_qty: number;
  low_stock_level: number; stocktake_date: string | null; counted_by_email: string | null;
};
type Activity = { kind: string; product_name: string; quantity: number; actor: string; happened_at: string };
type Workspace = { id: string; name: string; role: "owner" | "admin" | "member" };
type WorkspaceMember = { user_id: string; email: string; role: string };
type Tab = "count" | "stock" | "inbound" | "activity";
type UnitMode = "package" | "base";
type PdfLine = { productId: string; pieces: number; unitMode: UnitMode };
type NewProduct = {
  category: string; brand: string; flavor: string; name: string; spec: string;
  unit: string; packSize: string; initialPieces: string; lowStockLevel: string;
};
type OcrProgress = { label: string; percent: number };

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

  const signIn = async () => {
    if (!email.includes("@")) return setMessage("請輸入正確電郵地址");
    setBusy(true);
    const redirectTo = `${location.origin}${import.meta.env.BASE_URL}`;
    const { error } = await supabase.auth.signInWithOtp({ email, options: { shouldCreateUser: true, emailRedirectTo: redirectTo } });
    setBusy(false);
    setMessage(error ? "暫時未能寄出登入連結，請稍後再試。" : "登入連結已寄出，請檢查電郵。 ");
  };

  return <main className="public-shell">
    <section className="hero-card">
      <div className="app-mark">倉</div><p className="eyebrow">手機共享庫存</p>
      <h1>倉點 <span>Stockcheck</span></h1>
      <p>每間店舖有獨立庫存，邀請同事後即可多人同步盤點；其他店舖無法查看你嘅資料。</p>
      <div className="feature-grid"><span>✓ 每日 Stock Take</span><span>✓ 新產品及入貨</span><span>✓ PDF／圖片本機辨認</span><span>✓ 操作記錄</span></div>
      <label className="login-field">登入／開設帳戶<input type="email" inputMode="email" value={email} onChange={(e) => setEmail(e.target.value)} placeholder="name@example.com" /></label>
      <button className="primary-button" onClick={signIn} disabled={busy}>{busy ? "寄出中…" : "寄出安全登入連結"}</button>
      {message && <p className="form-message">{message}</p>}
      <button className="text-button" onClick={() => setPrivacy(true)}>私隱政策</button>
    </section>
    {privacy && <PrivacyDialog close={() => setPrivacy(false)} />}
  </main>;
}

function PrivacyDialog({ close }: { close: () => void }) {
  return <div className="modal-backdrop"><section className="modal privacy-modal"><div className="modal-head"><div><p className="eyebrow">Privacy</p><h2>私隱政策</h2></div><button onClick={close}>關閉</button></div><p>倉點只儲存獲授權使用者的電郵、產品資料、盤點與入貨記錄。PDF 及圖片會在使用者裝置內進行文字辨認，原檔不會上傳到 Stockcheck Database。</p><p>網站使用 Supabase 提供登入及共享資料庫，並可能使用 Google AdSense 顯示廣告。Google 可能按其政策使用 Cookie 或類似技術提供及量度廣告。</p><p>如要查閱或刪除帳戶資料，請聯絡網站管理員。使用本網站代表同意上述資料處理。</p></section></div>;
}

const normalizeOcr = (value: string) => value.normalize("NFKC").toLowerCase().replace(/[^\p{L}\p{N}]/gu, "");

function recognitionAliases(item: InventoryItem) {
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

function documentMatches(text: string, items: InventoryItem[]) {
  const rawLines = text.split(/\r?\n/).map((line) => line.trim()).filter(Boolean);
  const candidates = rawLines.map((line, index) => {
    const ownNumbers = [...line.matchAll(/(?:^|\s)(\d{1,3})(?=\s|$)/g)].map((match) => Number(match[1])).filter((value) => value > 0);
    if (ownNumbers.length) return { text: line, quantity: ownNumbers.at(-1)! };
    const next = rawLines[index + 1] ?? "";
    const nextNumbers = [...next.matchAll(/^(\d{1,3})$/g)].map((match) => Number(match[1])).filter((value) => value > 0);
    return nextNumbers.length ? { text: `${line} ${next}`, quantity: nextNumbers[0] } : null;
  }).filter((value): value is { text: string; quantity: number } => Boolean(value));
  const chosen = new Map<string, { score: number; lineIndex: number; quantity: number }>();
  candidates.forEach((candidate, lineIndex) => {
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
    if (!current || best.score > current.score) chosen.set(best.item.id, { score: best.score, lineIndex, quantity: candidate.quantity });
  });
  const matches: PdfLine[] = [];
  for (const [productId, value] of [...chosen.entries()].sort((a, b) => a[1].lineIndex - b[1].lineIndex)) {
    matches.push({ productId, pieces: value.quantity, unitMode: "package" });
  }
  return matches;
}

async function recognizeImage(source: File | HTMLCanvasElement, update: (progress: OcrProgress) => void) {
  const { createWorker, OEM } = await import("tesseract.js");
  const worker = await createWorker(["eng", "chi_tra"], OEM.LSTM_ONLY, { logger: (message) => {
    if (message.status === "recognizing text") update({ label: "辨認圖片文字", percent: Math.round(message.progress * 100) });
  } });
  try { const result = await worker.recognize(source); return result.data.text; }
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
  const [expanded, setExpanded] = useState<string | null>(null);
  const [counts, setCounts] = useState<Record<string, string>>({});
  const [countUnits, setCountUnits] = useState<Record<string, UnitMode>>({});
  const [busy, setBusy] = useState<string | null>(null);
  const [toast, setToast] = useState("");
  const [stockIn, setStockIn] = useState<{ productId: string; pieces: string; source: string; unitMode: UnitMode }>({ productId: "", pieces: "1", source: "手動入貨", unitMode: "package" });
  const [showNewProduct, setShowNewProduct] = useState(false);
  const [showWorkspace, setShowWorkspace] = useState(false);
  const [pdf, setPdf] = useState<{ filename: string; orderNumber: string; lines: PdfLine[] } | null>(null);
  const [pdfBusy, setPdfBusy] = useState(false);
  const [ocrProgress, setOcrProgress] = useState<OcrProgress | null>(null);
  const fileRef = useRef<HTMLInputElement>(null);

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

  useEffect(() => { setItems([]); setActivity([]); setStockIn((value) => ({ ...value, productId: "" })); refresh().catch(() => setToast("未能載入共享庫存，請稍後再試")); }, [workspace.id]);
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

  const handleDocument = async (file?: File) => {
    if (!file) return;
    if (file.size > 20 * 1024 * 1024) return setToast("檔案不可大過 20MB");
    const isPdf = file.type === "application/pdf" || file.name.toLowerCase().endsWith(".pdf");
    const isImage = file.type.startsWith("image/") || /\.(jpe?g|png)$/i.test(file.name);
    if (!isPdf && !isImage) return setToast("請選擇 PDF、JPG、JPEG 或 PNG");
    setPdfBusy(true); setOcrProgress({ label: "準備讀取檔案", percent: 0 });
    try {
      let text = "";
      if (isImage) {
        text = await recognizeImage(file, setOcrProgress);
      } else {
        const pdfjs = await import("pdfjs-dist/legacy/build/pdf.mjs");
        pdfjs.GlobalWorkerOptions.workerSrc = new URL("pdfjs-dist/legacy/build/pdf.worker.min.mjs", import.meta.url).toString();
        const pdfDocument = await pdfjs.getDocument({ data: new Uint8Array(await file.arrayBuffer()) }).promise;
        let embeddedText = "";
        for (let pageNo = 1; pageNo <= pdfDocument.numPages; pageNo++) {
          setOcrProgress({ label: `讀取 PDF 第 ${pageNo}/${pdfDocument.numPages} 頁`, percent: Math.round(pageNo / pdfDocument.numPages * 20) });
          const page = await pdfDocument.getPage(pageNo); const content = await page.getTextContent();
          embeddedText += "\n" + content.items.map((part) => "str" in part ? part.str : "").join(" ");
        }
        const embeddedMatches = documentMatches(embeddedText, items);
        if (embeddedMatches.length >= Math.min(3, items.length)) text = embeddedText;
        else {
          const { createWorker, OEM } = await import("tesseract.js");
          const worker = await createWorker(["eng", "chi_tra"], OEM.LSTM_ONLY, { logger: (message) => {
            if (message.status === "recognizing text") setOcrProgress((current) => ({ label: current?.label ?? "辨認 PDF", percent: Math.min(99, 20 + Math.round(message.progress * 80)) }));
          } });
          try {
            for (let pageNo = 1; pageNo <= pdfDocument.numPages; pageNo++) {
              setOcrProgress({ label: `OCR 辨認第 ${pageNo}/${pdfDocument.numPages} 頁`, percent: Math.round(20 + (pageNo - 1) / pdfDocument.numPages * 80) });
              const page = await pdfDocument.getPage(pageNo); const viewport = page.getViewport({ scale: 2 });
              const canvas = document.createElement("canvas"); canvas.width = Math.ceil(viewport.width); canvas.height = Math.ceil(viewport.height);
              const context = canvas.getContext("2d", { alpha: false }); if (!context) throw new Error("Canvas unavailable");
              await page.render({ canvas, canvasContext: context, viewport }).promise;
              const result = await worker.recognize(canvas); text += "\n" + result.data.text;
            }
          } finally { await worker.terminate(); }
        }
      }
      setOcrProgress({ label: "配對產品及數量", percent: 100 });
      const matches = documentMatches(text, items);
      setPdf({ filename: file.name, orderNumber: text.replace(/\s/g, "").match(/H\d{12}/i)?.[0]?.toUpperCase() ?? "", lines: matches });
      setToast(matches.length ? `已辨認 ${matches.length} 款，請逐項核對` : "未能自動配對，請喺核對頁手動加入產品");
    } catch (error) { console.error(error); setToast("未能讀取檔案，請確認圖片清晰或重試"); }
    finally { setPdfBusy(false); setOcrProgress(null); if (fileRef.current) fileRef.current.value = ""; }
  };

  const confirmPdf = async () => {
    if (!pdf?.lines.length) return; setBusy("pdf");
    const rows = pdf.lines.filter((line) => line.pieces > 0).map((line) => {
      const item = items.find((entry) => entry.id === line.productId)!;
      const unitsAdded = line.unitMode === "package" ? line.pieces * item.pack_size : line.pieces;
      return { workspace_id: workspace.id, product_id: item.id, pieces: line.unitMode === "package" ? line.pieces : 1, units_added: unitsAdded, entered_quantity: line.pieces, entered_unit: line.unitMode === "package" ? "箱／包" : item.unit, source: `上載檔案: ${pdf.filename}`, order_number: pdf.orderNumber || null, added_by: session.user.id, added_by_email: session.user.email };
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

    {tab === "count" && <section className="content-section"><div className="section-heading"><div><p className="eyebrow">按種類排列</p><h2>每日盤點</h2></div><span>{items.length - doneToday} 款未完成</span></div>{!items.length && <EmptyProducts open={() => { setTab("inbound"); setShowNewProduct(true); }} />}<div className="category-list">{groups.map(([category, products]) => { const complete = products.filter((item) => item.stocktake_date === today()).length; const open = expanded === category || Boolean(query); return <article className="category" key={category}><button className="category-head" onClick={() => setExpanded(open && !query ? null : category)}><span className="category-icon">{category.slice(0, 1)}</span><span><strong>{category}</strong><small>{products.length} 款產品</small></span><span className={complete === products.length ? "done-pill" : "count-pill"}>{complete}/{products.length}</span><b>{open ? "−" : "+"}</b></button>{open && <div className="product-list">{products.map((item) => <ProductCountCard key={item.id} item={item} value={counts[item.id] ?? ""} unitMode={countUnits[item.id] ?? "base"} onUnitChange={(unitMode) => setCountUnits((all) => ({ ...all, [item.id]: unitMode }))} onChange={(value) => setCounts((all) => ({ ...all, [item.id]: value }))} onSave={() => saveCount(item)} busy={busy === item.id} />)}</div>}</article>; })}</div></section>}

    {tab === "stock" && <section className="content-section"><div className="section-heading"><div><p className="eyebrow">即時共享</p><h2>庫存清單</h2></div><span>{filtered.length} 款</span></div><div className="stock-list">{groups.map(([category, products]) => <section key={category}><h3>{category}</h3>{products.map((item) => <div className="stock-row" key={item.id}><div><strong>{item.brand} · {item.flavor}</strong><span>{item.name}｜{item.spec}</span></div><div className={item.current_qty <= item.low_stock_level ? "qty low" : "qty"}><strong>{item.current_qty}</strong><small>{item.unit}</small></div></div>)}</section>)}</div></section>}

    {tab === "inbound" && <section className="content-section"><div className="section-heading"><div><p className="eyebrow">增加庫存</p><h2>新貨入庫</h2></div><button className="outline-button" onClick={() => setShowNewProduct(true)}>＋ 新增產品</button></div><div className="form-card"><label>現有產品<select value={stockIn.productId} onChange={(event) => setStockIn({ ...stockIn, productId: event.target.value })}><option value="">請選擇</option>{items.map((item) => <option value={item.id} key={item.id}>{item.category}｜{item.brand}｜{item.flavor}</option>)}</select></label><div className="quantity-unit-row"><label>新增數量<input inputMode="numeric" value={stockIn.pieces} onChange={(event) => setStockIn({ ...stockIn, pieces: event.target.value.replace(/\D/g, "") })} /></label><label>輸入單位<select value={stockIn.unitMode} onChange={(event) => setStockIn({ ...stockIn, unitMode: event.target.value as UnitMode })}><option value="package">箱／包</option><option value="base">{items.find((item) => item.id === stockIn.productId)?.unit ?? "件"}</option></select></label></div>{stockIn.productId && <div className="conversion-note">自動換算：<strong>{stockIn.unitMode === "package" ? Number(stockIn.pieces || 0) * (items.find((item) => item.id === stockIn.productId)?.pack_size ?? 0) : Number(stockIn.pieces || 0)}</strong> {items.find((item) => item.id === stockIn.productId)?.unit}</div>}<label>來源<input value={stockIn.source} onChange={(event) => setStockIn({ ...stockIn, source: event.target.value })} /></label><button className="primary-button" onClick={saveInbound} disabled={busy === "inbound"}>{busy === "inbound" ? "儲存中…" : "確認入貨"}</button></div><div className="pdf-card"><div className="pdf-icon">OCR</div><div><strong>從 PDF 或相片辨認</strong><p>支援 PDF、JPG、JPEG、PNG；完成後必須先核對，未確認唔會改庫存。</p></div><button onClick={() => fileRef.current?.click()} disabled={pdfBusy}>{pdfBusy ? `${ocrProgress?.percent ?? 0}%` : "選擇檔案"}</button><input ref={fileRef} hidden type="file" accept="application/pdf,image/jpeg,image/png,.jpg,.jpeg,.png" onChange={(event) => handleDocument(event.target.files?.[0])} /></div>{ocrProgress && <div className="ocr-progress"><div><span>{ocrProgress.label}</span><b>{ocrProgress.percent}%</b></div><i><em style={{ width: `${ocrProgress.percent}%` }} /></i><small>首次使用會下載中文及英文辨認模型，請保持網絡連線。</small></div>}</section>}

    {tab === "activity" && <section className="content-section"><div className="section-heading"><div><p className="eyebrow">可追查記錄</p><h2>最近操作</h2></div></div><div className="activity-list">{activity.length ? activity.map((entry, index) => <div className="activity-row" key={`${entry.happened_at}-${index}`}><span className={entry.kind === "盤點" ? "activity-icon count" : "activity-icon inbound"}>{entry.kind === "盤點" ? "✓" : "+"}</span><div><strong>{entry.product_name}</strong><p>{entry.actor} · {new Date(entry.happened_at).toLocaleString("zh-HK")}</p></div><b>{entry.kind === "盤點" ? entry.quantity : `+${entry.quantity}`}</b></div>) : <div className="empty">未有操作記錄</div>}</div></section>}

    <div className="ad-safe-gap" aria-label="Google 廣告安全區" />
    <nav className="bottom-nav">{([["count","盤點","✓"],["stock","庫存","▦"],["inbound","入貨","＋"],["activity","記錄","◷"]] as [Tab,string,string][]).map(([id,label,icon]) => <button key={id} className={tab === id ? "active" : ""} onClick={() => setTab(id)}><span>{icon}</span>{label}</button>)}</nav>
    {showNewProduct && <NewProductDialog session={session} workspaceId={workspace.id} close={() => setShowNewProduct(false)} saved={async () => { setShowNewProduct(false); setToast("新產品已加入共享清單"); await refresh(); }} />}
    {showWorkspace && <WorkspaceDialog session={session} workspace={workspace} workspaces={workspaces} changeWorkspace={changeWorkspace} reload={reloadWorkspaces} close={() => setShowWorkspace(false)} />}
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

function NewProductDialog({ session, workspaceId, close, saved }: { session: Session; workspaceId: string; close: () => void; saved: () => Promise<void> }) {
  const [form, setForm] = useState<NewProduct>({ category: "", brand: "", flavor: "", name: "", spec: "", unit: "件", packSize: "1", initialPieces: "1", lowStockLevel: "0" });
  const [busy, setBusy] = useState(false); const [error, setError] = useState("");
  const change = (key: keyof NewProduct, value: string) => setForm((all) => ({ ...all, [key]: value }));
  const save = async () => {
    const packSize = Number(form.packSize); const initialPieces = Number(form.initialPieces); const low = Number(form.lowStockLevel);
    if (![form.category, form.brand, form.flavor, form.name].every((v) => v.trim()) || !Number.isInteger(packSize) || packSize < 1 || !Number.isInteger(initialPieces) || initialPieces < 0 || !Number.isInteger(low) || low < 0) return setError("請填妥產品資料及正確數量");
    setBusy(true);
    const { data, error: productError } = await supabase.from("products").insert({ workspace_id: workspaceId, category: form.category.trim(), brand: form.brand.trim(), flavor: form.flavor.trim(), name: form.name.trim(), spec: form.spec.trim(), unit: form.unit.trim() || "件", pack_size: packSize, low_stock_level: low, created_by: session.user.id }).select("id").single();
    if (productError || !data) { setBusy(false); return setError("未能新增產品"); }
    if (initialPieces > 0) {
      const { error: stockError } = await supabase.from("stock_ins").insert({ workspace_id: workspaceId, product_id: data.id, pieces: initialPieces, units_added: initialPieces * packSize, entered_quantity: initialPieces, entered_unit: "箱／包", source: "首次入貨", added_by: session.user.id, added_by_email: session.user.email });
      if (stockError) { setBusy(false); return setError("產品已建立，但首次入貨未能儲存"); }
    }
    setBusy(false); await saved();
  };
  return <div className="modal-backdrop"><section className="modal"><div className="modal-head"><div><p className="eyebrow">共享產品目錄</p><h2>新增產品</h2></div><button onClick={close}>取消</button></div><div className="modal-form"><label>種類<input value={form.category} onChange={(e) => change("category", e.target.value)} placeholder="例如：薯片／脆片" /></label><div className="two-fields"><label>品牌<input value={form.brand} onChange={(e) => change("brand", e.target.value)} /></label><label>味道<input value={form.flavor} onChange={(e) => change("flavor", e.target.value)} /></label></div><label>產品名稱<input value={form.name} onChange={(e) => change("name", e.target.value)} /></label><div className="two-fields"><label>規格<input value={form.spec} onChange={(e) => change("spec", e.target.value)} placeholder="例如 25g x 30" /></label><label>盤點單位<input value={form.unit} onChange={(e) => change("unit", e.target.value)} placeholder="小包" /></label></div><div className="three-fields"><label>每箱／包件數<input inputMode="numeric" value={form.packSize} onChange={(e) => change("packSize", e.target.value.replace(/\D/g, ""))} /></label><label>首次箱／包數<input inputMode="numeric" value={form.initialPieces} onChange={(e) => change("initialPieces", e.target.value.replace(/\D/g, ""))} /></label><label>低存量警示<input inputMode="numeric" value={form.lowStockLevel} onChange={(e) => change("lowStockLevel", e.target.value.replace(/\D/g, ""))} /></label></div>{error && <p className="form-message error">{error}</p>}<button className="primary-button" onClick={save} disabled={busy}>{busy ? "儲存中…" : "建立並加入首次入貨"}</button></div></section></div>;
}

function WorkspaceDialog({ session, workspace, workspaces, changeWorkspace, reload, close }: { session: Session; workspace: Workspace; workspaces: Workspace[]; changeWorkspace: (id: string) => void; reload: () => Promise<void>; close: () => void }) {
  const [members, setMembers] = useState<WorkspaceMember[]>([]);
  const [inviteEmail, setInviteEmail] = useState("");
  const [newName, setNewName] = useState("");
  const [message, setMessage] = useState("");
  const [busy, setBusy] = useState(false);
  const canManage = workspace.role === "owner" || workspace.role === "admin";

  const loadMembers = async () => {
    const { data } = await supabase.from("workspace_members").select("user_id,email,role").eq("workspace_id", workspace.id).order("joined_at");
    setMembers((data ?? []) as WorkspaceMember[]);
  };
  useEffect(() => { loadMembers(); }, [workspace.id]);

  const invite = async () => {
    const email = inviteEmail.trim().toLowerCase();
    if (!email.includes("@")) return setMessage("請輸入正確電郵地址");
    setBusy(true);
    const { error } = await supabase.from("workspace_invites").insert({ workspace_id: workspace.id, email, role: "member", invited_by: session.user.id });
    setBusy(false);
    if (error) return setMessage(error.code === "23505" ? "呢個電郵已經邀請過" : "未能建立邀請");
    setInviteEmail(""); setMessage("邀請已建立。請叫對方用呢個電郵登入 Stockcheck，系統會自動加入。 ");
  };

  const createAnother = async () => {
    if (!newName.trim()) return setMessage("請輸入新店舖名稱");
    setBusy(true);
    const { data, error } = await supabase.rpc("create_workspace", { workspace_name: newName.trim() });
    setBusy(false);
    if (error || !data) return setMessage("未能建立新店舖");
    setNewName(""); await reload(); changeWorkspace(data as string); setMessage("新店舖已建立");
  };

  return <div className="modal-backdrop"><section className="modal workspace-modal"><div className="modal-head"><div><p className="eyebrow">Workspace</p><h2>店舖及成員</h2></div><button onClick={close}>完成</button></div><label className="workspace-picker">切換店舖<select value={workspace.id} onChange={(event) => changeWorkspace(event.target.value)}>{workspaces.map((item) => <option value={item.id} key={item.id}>{item.name}</option>)}</select></label><section className="member-panel"><div className="panel-title"><strong>{workspace.name}</strong><span>{workspace.role === "owner" ? "擁有人" : workspace.role === "admin" ? "管理員" : "成員"}</span></div>{members.map((member) => <div className="member-row" key={member.user_id}><span>{member.email}</span><b>{member.role === "owner" ? "擁有人" : member.role === "admin" ? "管理員" : "成員"}</b></div>)}</section>{canManage && <section className="workspace-form"><p className="eyebrow">邀請同事</p><div><input type="email" inputMode="email" value={inviteEmail} onChange={(event) => setInviteEmail(event.target.value)} placeholder="同事電郵" /><button onClick={invite} disabled={busy}>邀請</button></div><small>對方用相同電郵登入後，會自動加入呢間店。</small></section>}<section className="workspace-form"><p className="eyebrow">另一間獨立店舖</p><div><input value={newName} onChange={(event) => setNewName(event.target.value)} placeholder="新店舖／倉庫名稱" /><button onClick={createAnother} disabled={busy}>建立</button></div></section>{message && <p className="form-message">{message}</p>}<button className="logout-button" onClick={() => supabase.auth.signOut()}>登出 {session.user.email}</button></section></div>;
}

function UploadReview({ pdf, items, setPdf, confirm, busy }: { pdf: { filename: string; orderNumber: string; lines: PdfLine[] }; items: InventoryItem[]; setPdf: (value: typeof pdf | null) => void; confirm: () => void; busy: boolean }) {
  const totalUnits = pdf.lines.reduce((sum, line) => { const item = items.find((entry) => entry.id === line.productId); return sum + (line.unitMode === "package" ? line.pieces * (item?.pack_size ?? 0) : line.pieces); }, 0);
  const updateLine = (index: number, next: Partial<PdfLine>) => { const lines = [...pdf.lines]; lines[index] = { ...lines[index], ...next }; setPdf({ ...pdf, lines }); };
  const removeLine = (index: number) => setPdf({ ...pdf, lines: pdf.lines.filter((_line, lineIndex) => lineIndex !== index) });
  const addLine = () => { if (!items[0]) return; setPdf({ ...pdf, lines: [...pdf.lines, { productId: items[0].id, pieces: 1, unitMode: "package" }] }); };
  return <div className="review-page">
    <header className="review-topbar"><button onClick={() => setPdf(null)}>← 取消</button><div><p className="eyebrow">未更新庫存</p><h2>資料核對</h2></div><span>{pdf.lines.length} 項</span></header>
    <section className="review-summary"><div><span>上載檔案</span><strong>{pdf.filename}</strong></div><label>訂單編號<input value={pdf.orderNumber} onChange={(event) => setPdf({ ...pdf, orderNumber: event.target.value })} placeholder="如有訂單編號請填寫" /></label><div className="review-totals"><span>辨認項目 <b>{pdf.lines.length}</b></span><span>預計新增 <b>{totalUnits}</b> 件</span></div></section>
    <section className="review-list"><div className="review-heading"><div><p className="eyebrow">逐項確認</p><h3>產品及數量</h3></div><button className="outline-button" onClick={addLine}>＋ 加漏咗嘅貨</button></div>
      {!pdf.lines.length && <div className="empty-card"><strong>未辨認到產品</strong><p>按「加漏咗嘅貨」手動加入，再確認入庫。</p></div>}
      {pdf.lines.map((line, index) => { const item = items.find((entry) => entry.id === line.productId); const converted = line.unitMode === "package" ? line.pieces * (item?.pack_size ?? 0) : line.pieces; return <article className="review-item" key={`${index}-${line.productId}`}><div className="review-item-number">{index + 1}</div><div className="review-fields"><label>產品<select value={line.productId} onChange={(event) => updateLine(index, { productId: event.target.value })}>{items.map((entry) => <option key={entry.id} value={entry.id}>{entry.category}｜{entry.brand}｜{entry.flavor}</option>)}</select></label><div className="review-quantity"><label>數量<input inputMode="numeric" value={line.pieces} onChange={(event) => updateLine(index, { pieces: Math.max(0, Number(event.target.value.replace(/\D/g, ""))) })} /></label><label>輸入單位<select value={line.unitMode} onChange={(event) => updateLine(index, { unitMode: event.target.value as UnitMode })}><option value="package">箱／包</option><option value="base">{item?.unit ?? "件"}</option></select></label><div><span>自動換算</span><strong>{converted} {item?.unit}</strong></div></div></div><button className="remove-button" onClick={() => removeLine(index)} aria-label="刪除項目">×</button></article>; })}
    </section>
    <footer className="review-footer"><div><span>確認後更新共享 Database</span><strong>{pdf.lines.length} 項 · {totalUnits} 件</strong></div><button className="primary-button" onClick={confirm} disabled={busy || !pdf.lines.length || pdf.lines.some((line) => line.pieces <= 0)}>{busy ? "同步中…" : "確認全部入庫"}</button></footer>
  </div>;
}
