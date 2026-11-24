/* Fonctions partagées : lecture des CSV Google Sheets et analyse des grilles d'évaluation */
const SOURCE = "https://docs.google.com/spreadsheets/d/e/2PACX-1vQquSPj8u65m-DQ3Ey3TDspKyf-z0F9S1Sfef0bvkwZ4NfNuDHQdOxov64uT1rXp84lYvVldrGhu_y6/pub?gid=835244219&single=true&output=csv";

const COLS = {
  date: "Horodateur",
  login: "Votre login Github",
  gridP: "Votre proposition de grille d'évaluation pour les projets",
  resP: "Résultat de l'évaluation des projets",
  gridS: "Votre proposition de grille d'évaluation pour les présentations",
  resS: "Résultat de l'évaluation des présentations",
};

const parseDate = d3.timeParse("%d/%m/%Y %H:%M:%S");
const tip = d3.select("#tip");
function showTip(ev, html) {
  tip.html(html).style("opacity", 1);
  const w = tip.node().offsetWidth;
  tip.style("left", Math.min(ev.clientX + 14, innerWidth - w - 8) + "px").style("top", (ev.clientY + 14) + "px");
}
function hideTip() { tip.style("opacity", 0); }
const esc = s => String(s ?? "").replace(/[&<>"]/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]));

// Retourne l'URL CSV candidate et la nature de la conversion
function csvCandidate(url) {
  if (!url) return null;
  const gid = (url.match(/[?&#]gid=(\d+)/) || [])[1];
  if (/\/spreadsheets\/d\/e\/[^/]+\/pub\?/.test(url) && /output=csv/.test(url)) return { url, fixed: null };
  let m = url.match(/(https:\/\/docs\.google\.com\/spreadsheets\/d\/e\/[^/]+)\/pub(html)?/);
  if (m) return { url: `${m[1]}/pub?${gid ? `gid=${gid}&single=true&` : ""}output=csv`, fixed: "pubhtml → CSV" };
  m = url.match(/https:\/\/docs\.google\.com\/spreadsheets\/d\/([^/]+)/);
  if (m) return { url: `https://docs.google.com/spreadsheets/d/${m[1]}/export?format=csv${gid ? `&gid=${gid}` : ""}`, fixed: "lien /edit → export CSV" };
  return null;
}

async function loadResult(url) {
  const cand = csvCandidate(url);
  if (!cand) return { status: "bad", label: "Lien non reconnu" };
  try {
    const txt = await d3.text(cand.url);
    if (/^\s*</.test(txt)) return { status: "bad", label: "Page HTML, pas un CSV" };
    const rows = d3.csvParse(txt);
    return {
      status: rows.length ? (cand.fixed ? "warn" : "good") : "empty",
      label: rows.length ? `${rows.length} réponse${rows.length > 1 ? "s" : ""}` : "Publié mais vide",
      fixed: cand.fixed, rows, columns: rows.columns,
    };
  } catch (e) {
    return { status: "bad", label: "Privé ou inaccessible", fixed: cand.fixed };
  }
}

/* ---------- Analyse des colonnes ---------- */
const isMeta = c => /^horodateur$/i.test(c.trim()) || /e-?mail/i.test(c);
const isIdentity = c => /\bnom\b|pr[ée]nom|login|^\s*quels? (est le nom du )?projet|nom du projet|url du projet|^\s*dans quel cadre|^\s*quels? version/i.test(c);
function toNumber(v) {
  if (v == null) return NaN;
  const m = String(v).trim().match(/^(-?\d+(?:[.,]\d+)?)/);
  return m ? +m[1].replace(",", ".") : NaN;
}
function cleanLabel(c) { return c.replace(/\s*\n[\s\S]*$/, "").replace(/\s*\(Échelle[\s\S]*$/i, "").replace(/^\s*\d+\s*[-.]\s*/, "").trim(); }
function maxFromHeader(c) { const m = c.match(/\/\s*(\d+)\s*\)?\s*$/) || c.match(/\(\s*\/\s*(\d+)\s*\)/); return m ? +m[1] : null; }

function analyse(res) {
  if (!res.rows) return null;
  const out = { criteria: [], identity: [], comments: [] };
  for (const c of res.columns) {
    if (isMeta(c)) continue;
    const vals = res.rows.map(r => (r[c] ?? "").trim()).filter(v => v !== "");
    if (isIdentity(c)) { out.identity.push(c); continue; }
    const yn = vals.length && vals.every(v => /^(oui|non)$/i.test(v));
    const nums = vals.map(toNumber);
    const numeric = vals.length && nums.every(n => !isNaN(n));
    if (yn) {
      const oui = vals.filter(v => /^oui$/i.test(v)).length;
      out.criteria.push({ col: c, label: cleanLabel(c), type: "yn", oui, non: vals.length - oui, n: vals.length });
    } else if (numeric) {
      const hmax = maxFromHeader(c);
      const vmax = d3.max(nums);
      // une valeur libellée « Excellent » indique le maximum du barème
      const exc = vals.filter(v => /excellent/i.test(v)).map(toNumber);
      const max = hmax ?? (exc.length ? d3.max(exc) : null) ?? (vmax <= 5 ? 5 : vmax <= 10 ? 10 : 20);
      out.criteria.push({ col: c, label: cleanLabel(c), type: "num", mean: d3.mean(nums), min: d3.min(nums), max, values: nums, n: vals.length });
    } else if (!vals.length) {
      out.criteria.push({ col: c, label: cleanLabel(c), type: "none", n: 0 });
    } else {
      out.criteria.push({ col: c, label: cleanLabel(c), type: "text", n: vals.length });
      res.rows.forEach(r => { const v = (r[c] ?? "").trim(); if (v) out.comments.push({ crit: cleanLabel(c), text: v, who: out.identity.map(i => r[i]).filter(Boolean).join(" · ") }); });
    }
  }
  return out;
}


const STATUS = {
  good: { c: "var(--good)", icon: "✓" },
  warn: { c: "var(--warning)", icon: "!" },
  empty: { c: "var(--warning)", icon: "○" },
  bad: { c: "var(--critical)", icon: "✕" },
};
function statusHTML(st, label, sub) {
  const s = STATUS[st];
  return `<span class="status"><i class="dot" style="background:${s.c}"></i><span aria-hidden="true">${s.icon}</span> ${esc(label)}</span>${sub ? `<br><small style="color:var(--text-muted)">${esc(sub)}</small>` : ""}`;
}

