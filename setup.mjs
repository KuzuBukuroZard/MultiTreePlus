const NS = "kuzubukuro_multitree_plus";

function clampInt(v, min, max) {
  const n = Number(v);
  if (!Number.isFinite(n)) return min;
  return Math.max(min, Math.min(max, Math.floor(n)));
}

function parseIDs(raw) {
  if (!raw) return [];
  if (Array.isArray(raw)) return raw.filter(Boolean).map(String);
  return String(raw)
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
}

// Generate an isolation key for the current save file (by character name)
function getScopedStoreKey() {
  const name = String(game?.characterName ?? "default").trim() || "default";
  // Use encodeURIComponent to safely encode all characters (supports Chinese/Japanese, etc.)
  const safe = encodeURIComponent(name).slice(0, 120);
  return `${NS}:activeTreeIDs:${safe}`;
}

// ---------- Silent storage adapter (characterData preferred, localStorage fallback) ----------
function makeSilentStore(ctx) {
  const cd = ctx?.characterData;

  // Support both getItem/setItem and get/set (varies by SDK/version)
  const cdGet =
    cd && (typeof cd.getItem === "function" ? cd.getItem.bind(cd) :
           typeof cd.get === "function" ? cd.get.bind(cd) : null);

  const cdSet =
    cd && (typeof cd.setItem === "function" ? cd.setItem.bind(cd) :
           typeof cd.set === "function" ? cd.set.bind(cd) : null);

  function get() {
    const key = getScopedStoreKey();

    // Optional migration: if old global key exists, move it into scoped key once
    try {
      const old = `${NS}:activeTreeIDs`;
      if (!localStorage.getItem(key) && localStorage.getItem(old)) {
        localStorage.setItem(key, localStorage.getItem(old));
        localStorage.removeItem(old);
      }
    } catch {}

    // 1) characterData
    if (cdGet) {
      try {
        const v = cdGet(key);
        if (Array.isArray(v)) return v;
      } catch {}
    }
    // 2) localStorage fallback
    try {
      const raw = localStorage.getItem(key);
      const v = raw ? JSON.parse(raw) : null;
      return Array.isArray(v) ? v : [];
    } catch {
      return [];
    }
  }

  function set(ids) {
    const key = getScopedStoreKey();
    const arr = Array.isArray(ids) ? ids : [];
    // 1) characterData
    if (cdSet) {
      try { cdSet(key, arr); } catch {}
    }
    // 2) localStorage fallback (always write; helps local mods / dev)
    try { localStorage.setItem(key, JSON.stringify(arr)); } catch {}
  }

  return { get, set };
}

// ---------- Patch helpers (official patch API if available; otherwise wrap) ----------
function hasPatchAPI(ctx) {
  return ctx && typeof ctx.patch === "function";
}

function patchGetter_treeCutLimit(ctx, getMaxTrees) {
  // Preferred: official patch API
  if (hasPatchAPI(ctx) && typeof globalThis.Woodcutting !== "undefined") {
    try {
      // Some SDKs support ctx.isPatched; if not present, just patch once using a flag
      if (ctx.isPatched?.(Woodcutting, "treeCutLimit")) return;

      ctx.patch(Woodcutting, "treeCutLimit").get((origGet) => {
        const base = origGet();
        const maxTrees = getMaxTrees();
        return Math.max(base, maxTrees);
      });
      return;
    } catch (e) {
      console.warn("[MultiTree+] patch API failed for treeCutLimit, falling back.", e);
    }
  }

  // Fallback: defineProperty on prototype owner where treeCutLimit is defined
  const wc = game?.woodcutting;
  if (!wc) return;

  // find descriptor in proto chain
  let p = wc;
  while (p && p !== Object.prototype) {
    const d = Object.getOwnPropertyDescriptor(p, "treeCutLimit");
    if (d) {
      const origGet = d.get;
      const origVal = "value" in d ? d.value : undefined;

      if (p.__multitreePlusPatchedTreeCutLimit) return;
      p.__multitreePlusPatchedTreeCutLimit = true;

      Object.defineProperty(p, "treeCutLimit", {
        configurable: true,
        enumerable: !!d.enumerable,
        get() {
          const base = origGet ? origGet.call(this) : origVal;
          const maxTrees = getMaxTrees();
          return Math.max(Number(base ?? 0), maxTrees);
        },
      });
      return;
    }
    p = Object.getPrototypeOf(p);
  }
}

function patchAfter_selectTree(ctx, afterFn) {
  // Preferred: official patch API
  if (hasPatchAPI(ctx) && typeof globalThis.Woodcutting !== "undefined") {
    try {
      if (ctx.isPatched?.(Woodcutting, "selectTree")) return;
      ctx.patch(Woodcutting, "selectTree").after(function (...args) {
        // "this" should be the Woodcutting instance
        try { afterFn.call(this, ...args); } catch (e) { console.error(e); }
      });
      return;
    } catch (e) {
      console.warn("[MultiTree+] patch API failed for selectTree, falling back.", e);
    }
  }

  // Fallback: wrap instance method
  const wc = game?.woodcutting;
  if (!wc || typeof wc.selectTree !== "function") return;
  if (wc.__multitreePlusWrappedSelectTree) return;
  wc.__multitreePlusWrappedSelectTree = true;

  const orig = wc.selectTree;
  wc.selectTree = function (...args) {
    const res = orig.apply(this, args);
    try { afterFn.apply(this, args); } catch (e) { console.error(e); }
    return res;
  };
}

// ---------- Restore logic ----------
function restoreActiveTreesFromSaved(wc, ids, maxTrees) {
  if (!wc || !Array.isArray(ids) || ids.length === 0) return;

  // Determine realm constraint:
  // Official selectTree requires all activeTrees share the same realm.
  // We'll follow that: if current activeTrees has a realm, only add matching ones.
  let realm = null;
  const current = Array.from(wc.activeTrees ?? []);
  if (current.length > 0) realm = current[0].realm;

  // Add trees up to maxTrees, do not remove existing ones.
  for (const id of ids) {
    if ((wc.activeTrees?.size ?? 0) >= maxTrees) break;

    // Resolve tree object by ID; in your build wc.actions.getObjectByID works
    const tree = wc.actions?.getObjectByID?.(id);
    if (!tree) continue;

    if (realm == null) realm = tree.realm;
    if (tree.realm !== realm) continue;

    wc.activeTrees.add(tree);
  }

  // If there is at least one active tree, start the action (and refresh UI state)
  if ((wc.activeTrees?.size ?? 0) > 0) {
    wc.renderQueue.selectedTrees = true;
    wc.start?.();
  } else {
    wc.stop?.();
  }
}

// ---------- Main ----------
export function setup(ctx) {
  // 1) Register Mod Settings (visible in hamburger menu)
  const section = ctx.settings.section("MultiTree+");
  section.add([
    {
      type: "switch",
      name: "enabled",
      label: "Enable MultiTree+",
      hint: "Allows you to cut more trees simultaneously when enabled.",
      default: true,
    },
    {
      type: "number",
      name: "maxTrees",
      label: "Maximum Trees Cut Simultaneously",
      hint: "Recommended 3~6. Higher values may impact performance.",
      default: 3,
    },
    {
      type: "switch",
      name: "remember",
      label: "Silently Remember and Auto-Resume Selection",
      hint: "When enabled, your current tree selection will be remembered when leaving/reloading the character and automatically restored on next load (up to the 'Maximum Trees Cut Simultaneously' limit).",
      default: true,
    },
  ]);

  const store = makeSilentStore(ctx);

  function getEnabled() {
    try { return !!section.get("enabled"); } catch { return true; }
  }
  function getRemember() {
    try { return !!section.get("remember"); } catch { return true; }
  }
  function getMaxTrees() {
    // IMPORTANT: Always at least 2; cap at something reasonable to prevent UI/edge issues.
    let v = 3;
    try { v = section.get("maxTrees"); } catch {}
    return clampInt(v, 2, 20);
  }

  // 2) Patch treeCutLimit so selectTree naturally allows more trees
  patchGetter_treeCutLimit(ctx, () => {
    if (!getEnabled()) return 0;            // disabled -> do not increase
    return getMaxTrees();
  });

  // 3) Silent save: after each selectTree, store activeTrees IDs
  patchAfter_selectTree(ctx, function () {
    if (!getEnabled() || !getRemember()) return;
    const ids = Array.from(this.activeTrees ?? [])
      .map((t) => t.id ?? t.localID)
      .filter(Boolean)
      .map(String);
    store.set(ids);
  });

  // 4) Silent restore: when character loaded, add saved trees back (up to maxTrees)
  ctx.onCharacterLoaded(() => {
    if (!getEnabled() || !getRemember()) return;
    const wc = game?.woodcutting;
    if (!wc) return;

    const ids = parseIDs(store.get());
    if (ids.length === 0) return;

    restoreActiveTreesFromSaved(wc, ids, getMaxTrees());
  });

  console.log("[MultiTree+] loaded (settings menu + silent remember)");
}
