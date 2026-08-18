(function () {
  "use strict";

  const __host = String(window.location.hostname || "").toLowerCase();
  const __isShuffleHost = /(^|\.)shuffle\.com$|^(localhost|127\.0\.0\.1)$/i.test(__host);
  const __isSwappedHost = /(^|\.)swapped\.com$/i.test(__host);
  const __isKycProviderHost = /(^|\.)(sumsub\.com|onfido\.com|veriff\.me|withpersona\.com)$/i.test(__host);
  const __isStripeElementsHost = /(^|\.)stripe\.com$/i.test(__host);
  const __defaultUsername = "rain";
  let __preferredUsername = __defaultUsername;
  const __demoBalanceBridgeKey = "__larpDemoBalanceSync";
  const __isExternalGameHost = /amazonaws\.com$|cloudfront\.net$/i.test(__host);
  const __isPragmaticLiveHost = /pragmaticplaylive\.net$|pragmaticplay\.net$|ppgames\.net$|pragmaticplaylive\.com$|gs2c\.com$|gs2c\.pragmaticplay\.net$/i.test(__host);

  const ShadowRootRegistry = {
    roots: new Set(),

    init() {
      if (window.__larpShadowRootRegistryInstalled || typeof Element === "undefined" || !Element.prototype?.attachShadow) {
        return;
      }
      window.__larpShadowRootRegistryInstalled = true;
      const originalAttachShadow = Element.prototype.attachShadow;
      const registry = this;
      Element.prototype.attachShadow = function patchedAttachShadow(init) {
        const shadowRoot = originalAttachShadow.call(this, init);
        registry.capture(shadowRoot);
        return shadowRoot;
      };
    },

    capture(root) {
      if (typeof ShadowRoot !== "undefined" && root instanceof ShadowRoot) {
        this.roots.add(root);
      }
    },

    getRoots() {
      const roots = [];
      for (const root of this.roots) {
        if (root?.host?.isConnected) {
          roots.push(root);
        } else {
          this.roots.delete(root);
        }
      }
      return roots;
    },
  };

  ShadowRootRegistry.init();

  // Stripe card iframe: do not touch network/postMessage (breaks Elements loading).
  // Visual-only: keep typed text white if invalid styles apply.
  if (__isStripeElementsHost) {
    try {
      const style = document.createElement("style");
      style.textContent = "html,body,input,.InputElement{color:#fff!important;caret-color:#fff!important;}";
      (document.documentElement || document.head)?.appendChild(style);
    } catch (e) {
    }
    return;
  }

  // Real Swapped widget / KYC providers.
  // IMPORTANT: do not spoof widget bootstrap APIs or Stripe Elements will hang on skeletons.
  if (__isSwappedHost || __isKycProviderHost) {
    let __larpPayInFlight = false;

    const __larpSwappedNotify = (extra = {}) => {
      let currency = "";
      let usdAmount = 0;
      try {
        const params = new URLSearchParams(window.location.search || "");
        currency = String(params.get("currencyCode") || params.get("currency") || "").toUpperCase();
        usdAmount = Number(params.get("baseCurrencyAmount") || params.get("amount") || 0);
      } catch (e) {
      }
      const payload = {
        type: "__larpSwappedPurchase",
        currency: currency || extra.currency || "",
        usdAmount: Number.isFinite(usdAmount) && usdAmount > 0 ? usdAmount : (extra.usdAmount || 0),
        cryptoAmount: extra.cryptoAmount || 0,
        source: "swapped-widget",
        at: Date.now(),
      };
      try {
        window.parent.postMessage(payload, "*");
      } catch (e) {
      }
      try {
        if (window.top && window.top !== window) {
          window.top.postMessage(payload, "*");
        }
      } catch (e) {
      }
      console.log("[LARP:Swapped] purchase simulated → parent notified", payload);
    };

    const __larpIsKycScreen = () => {
      const text = String(document.body?.innerText || "").slice(0, 8000);
      return /KYC Identity/i.test(text)
        || /Verify your identity to continue with Swapped/i.test(text);
    };

    const __larpSkipKycUi = () => {
      if (!__larpIsKycScreen()) {
        return;
      }
      document.querySelectorAll("div, section, aside").forEach((el) => {
        if (!(el instanceof HTMLElement) || el.getAttribute("data-larp-kyc-skipped") === "1") {
          return;
        }
        const t = String(el.textContent || "").replace(/\s+/g, " ").trim();
        if (t.length > 500 || t.length < 20) {
          return;
        }
        if (!/KYC Identity/i.test(t) && !/Verify your identity to continue with Swapped/i.test(t)) {
          return;
        }
        let node = el;
        for (let i = 0; i < 8 && node; i++) {
          const box = node;
          const bt = String(box.textContent || "");
          if (/Continue/i.test(bt) && /KYC Identity|Verify your identity/i.test(bt) && bt.length < 1200) {
            box.style.setProperty("display", "none", "important");
            box.setAttribute("data-larp-kyc-skipped", "1");
            break;
          }
          node = node.parentElement;
        }
      });
    };

    const __larpClearCardErrors = () => {
      document.querySelectorAll(".StripeElement--invalid").forEach((el) => {
        el.classList.remove("StripeElement--invalid");
        el.classList.add("StripeElement--complete");
      });

      // Only hide explicit incorrect-card error copy — never empty nodes (those are loaders).
      document.querySelectorAll("p, span").forEach((el) => {
        if (!(el instanceof HTMLElement)) {
          return;
        }
        const t = String(el.textContent || "").replace(/\s+/g, " ").trim();
        if (/^Your card details look incorrect\. Please check and try again\.$/i.test(t)) {
          el.style.setProperty("display", "none", "important");
          const wrap = el.closest('[class*="error"], [class*="Error"]');
          if (wrap instanceof HTMLElement) {
            wrap.style.setProperty("display", "none", "important");
          }
        }
      });
    };

    const __larpUnlockPayNow = () => {
      const btn = document.querySelector("#button-submit");
      if (!(btn instanceof HTMLButtonElement)) {
        return;
      }
      btn.disabled = false;
      btn.removeAttribute("disabled");
      btn.removeAttribute("data-disabled");
      btn.classList.remove("opacity-disabled", "pointer-events-none");
      btn.style.pointerEvents = "auto";
      btn.style.opacity = "1";
      btn.style.cursor = "pointer";
    };

    const __larpShowPaymentPending = () => {
      const host = document.querySelector('[data-drawer="main"]')
        || document.querySelector("#widget-container")
        || document.body;
      if (!(host instanceof HTMLElement)) {
        return;
      }

      let panel = document.getElementById("larp-swapped-pending");
      if (!panel) {
        panel = document.createElement("div");
        panel.id = "larp-swapped-pending";
        panel.style.cssText = "position:absolute;inset:0;z-index:9999;display:flex;flex-direction:column;align-items:center;justify-content:center;gap:14px;padding:24px;background:#121212;color:#fff;text-align:center;border-radius:16px;";
        if (getComputedStyle(host).position === "static") {
          host.style.position = "relative";
        }
        host.appendChild(panel);
      }

      panel.innerHTML = `
        <div style="width:42px;height:42px;border-radius:50%;border:3px solid rgba(255,255,255,.15);border-top-color:#7c5cff;animation:larpSwPend .8s linear infinite"></div>
        <div style="font-size:18px;font-weight:800">Payment pending</div>
        <div style="font-size:13px;color:rgba(255,255,255,.55);max-width:260px">Confirming your card payment with Swapped…</div>
      `;
      if (!document.getElementById("larp-swapped-pending-style")) {
        const style = document.createElement("style");
        style.id = "larp-swapped-pending-style";
        style.textContent = "@keyframes larpSwPend{to{transform:rotate(360deg)}}";
        document.documentElement.appendChild(style);
      }
    };

    const __larpShowPaymentComplete = () => {
      const panel = document.getElementById("larp-swapped-pending");
      if (!panel) {
        return;
      }
      panel.innerHTML = `
        <div style="font-size:34px;color:#7dffa8">✓</div>
        <div style="font-size:18px;font-weight:800">Payment received</div>
        <div style="font-size:13px;color:rgba(255,255,255,.55);max-width:260px">Crypto is being credited to your Shuffle wallet.</div>
      `;
    };

    const __larpTick = () => {
      if (__larpPayInFlight) {
        return;
      }
      __larpClearCardErrors();
      __larpUnlockPayNow();
      __larpSkipKycUi();
    };

    document.addEventListener("click", (event) => {
      const btn = event.target && event.target.closest && event.target.closest("button");
      if (!btn) {
        return;
      }
      const text = String(btn.textContent || "").replace(/\s+/g, " ").trim();
      const isPay = btn.id === "button-submit" || /^pay now$/i.test(text);
      if (!isPay || __larpPayInFlight) {
        return;
      }

      // Bypass real Stripe confirm so fake cards never hang the widget.
      event.preventDefault();
      event.stopPropagation();
      if (typeof event.stopImmediatePropagation === "function") {
        event.stopImmediatePropagation();
      }

      __larpPayInFlight = true;
      __larpClearCardErrors();
      __larpShowPaymentPending();

      setTimeout(() => {
        __larpSwappedNotify({ pending: true });
        __larpShowPaymentComplete();
        __larpPayInFlight = false;
      }, 1800);
    }, true);

    const boot = () => {
      __larpTick();
      setInterval(__larpTick, 1000);
      console.log("[LARP:Swapped] light intercept — widget load untouched; Pay Now simulates pending");
    };
    if (document.readyState === "loading") {
      document.addEventListener("DOMContentLoaded", boot, { once: true });
    } else {
      boot();
    }

    return;
  }

  if (__isPragmaticLiveHost) {
    initLiveCasinoFromTool();
    return;
  }

  /**
   * Live Casino SoftSwiss protocol — ported from live_casino_proxy.py
   * Injected into Tampermonkey for pragmaticplaylive hosts.
   */
  /**
   * SoftSwiss live casino (baccarat / roulette / BJ) — Tampermonkey port of live_casino_proxy.py
   *
   * Roulette path (Speed + Gates):
   *   betValidationError → fake {bet} accept + track
   *   gameresult.score   → calc payout + credit + queue win inject
   *   next WS message    → SoftSwiss {win} inject
   *
   * Gates-only difference (same as proxy):
   *   table id / toggle → 21x straights (EU/Speed = 36x)
   *   WS lucky harvest  → overrides straight mult for that number
   *   bonusNumber       → remembered (proxy parity; no separate DOM engine)
   *
   * Cross-frame (TM only — mitmproxy has one process):
   *   Shuffle parent holds a unified bet book and relays RESULT with bets attached.
   */
  function initLiveCasinoFromTool() {
    if (window.__larpLiveCasinoTool) {
      return;
    }
    window.__larpLiveCasinoTool = true;

    const BRIDGE = "__larpDemoBalanceSync";
    const BAL_KEY = "larp_live_casino_balance";
    const SHARED_BETS_KEY = "larp_live_shared_bets";
    const FRAME_ID = `f${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`;
    const LOG = (...args) => {
      try {
        console.log("[LARP:LiveCasino]", ...args);
      } catch (e) {
      }
    };

    const ROULETTE_RED = new Set([1, 3, 5, 7, 9, 12, 14, 16, 18, 19, 21, 23, 25, 27, 30, 32, 34, 36]);
    const ROULETTE_BLACK = new Set([2, 4, 6, 8, 10, 11, 13, 15, 17, 20, 22, 24, 26, 28, 29, 31, 33, 35]);

    const STATE = {
      enabled: true,
      balance: 10000,
      // Gates of Olympus — mirror live_casino_proxy STATE
      gatesOlympus: false,
      gatesLucky: {},
      gatesBonusNumber: null,
      pending_bets: [],
      table_id: "",
      user_id: "ppc1735345687125",
      seq_counter: 9000,
      prev_player_wins: -1,
      prev_banker_wins: -1,
      prev_tie_count: -1,
      last_bac_payout: 0,
      roulette_table: "",
      roulette_bets: [],
      bj_table: "",
      bj_bet_amount: 0,
      bj_game_id: "",
      bj_active: false,
      bj_player_score: 0,
      bj_dealer_score: 0,
      bj_decided: false,
    };

    let __bc = null;
    try {
      __bc = new BroadcastChannel("larp-live-casino");
    } catch (e) {
    }

    function postToParent(extra) {
      const payload = { [BRIDGE]: true, ...extra, at: Date.now(), frameId: FRAME_ID };
      [window.parent, window.top].forEach((w) => {
        if (!w || w === window) return;
        try {
          w.postMessage(payload, "*");
        } catch (e) {
        }
      });
    }

    function getBalance() {
      return Number(STATE.balance) || 0;
    }

    function setBalance(bal) {
      STATE.balance = Math.max(0, Number(bal) || 0);
      try {
        localStorage.setItem(BAL_KEY, String(STATE.balance));
      } catch (e) {
      }
      postToParent({ type: "BALANCE_UPDATE", balanceUsd: getBalance(), source: "live-casino" });
    }

    function nextSeq() {
      STATE.seq_counter += 1;
      return STATE.seq_counter;
    }

    function requestBalanceFromAncestors() {
      postToParent({ type: "REQUEST_BALANCE" });
    }

    function loadPersisted() {
      try {
        const bal = Number(localStorage.getItem(BAL_KEY));
        if (Number.isFinite(bal) && bal >= 0) STATE.balance = bal;
      } catch (e) {
      }
    }

    // --- Gates helpers (thin — match live_casino_proxy._gates_mode / harvest) ---

    function isGatesTableId(tableId) {
      return /gatesofolympus|gohroulette|roulett?goh|olympus/i.test(String(tableId || ""));
    }

    function gatesMode(table) {
      if (STATE.gatesOlympus) return true;
      const hay = `${table || ""} ${STATE.roulette_table || ""}`.toLowerCase();
      if (isGatesTableId(hay)) {
        STATE.gatesOlympus = true;
        return true;
      }
      return false;
    }

    function setGates(on) {
      STATE.gatesOlympus = !!on;
      LOG("gates olympus", STATE.gatesOlympus ? "ON (21x)" : "OFF (36x)");
    }

    function straightMult(resultNum, table) {
      if (!gatesMode(table)) return 36;
      // Prefer lucky map from gorRng; else last gameresult.mul; else Gates base 21x.
      const lucky = Number(STATE.gatesLucky[resultNum] ?? STATE.gatesLucky[String(resultNum)]);
      if (Number.isFinite(lucky) && lucky >= 2) return lucky;
      const fromResult = Number(STATE._gatesResultMul);
      if (Number.isFinite(fromResult) && fromResult >= 2) return fromResult;
      return 21;
    }

    /**
     * Gates SoftSwiss harvest from real traffic (gates-olympus-net log):
     *   gorRng: { bonusNo, bonusSlotId, luckyMul:[{mul,slot,slotId}] }
     *   gameresult: { result, color, mul, luckyWin, id, resultBetCodeId }
     */
    function harvestGatesFromObject(data) {
      if (!data || typeof data !== "object") return;

      if (data.gorRng && typeof data.gorRng === "object") {
        STATE.gatesOlympus = true;
        STATE.roulette_table = STATE.roulette_table || "gatesofolympus01";
        const rng = data.gorRng;
        const bonusNo = Number(rng.bonusNo);
        if (Number.isInteger(bonusNo) && bonusNo >= 0 && bonusNo <= 36) {
          STATE.gatesBonusNumber = bonusNo;
        }
        // Clear prior luckies when a new gorRng arrives for a round.
        STATE.gatesLucky = {};
        const list = Array.isArray(rng.luckyMul) ? rng.luckyMul : [];
        list.forEach((entry) => {
          if (!entry || typeof entry !== "object") return;
          const slot = Number(entry.slot);
          const mul = Number(entry.mul);
          if (Number.isInteger(slot) && slot >= 0 && slot <= 36 && mul >= 2) {
            STATE.gatesLucky[slot] = mul;
          }
        });
        LOG("gorRng", {
          gameId: rng.gameId,
          bonusNo: STATE.gatesBonusNumber,
          lucky: { ...STATE.gatesLucky },
        });
        postToParent({
          type: "LIVE_CASINO_LUCKY",
          lucky: { ...STATE.gatesLucky },
          bonusNumber: STATE.gatesBonusNumber,
        });
      }

      if (data.game && typeof data.game === "object") {
        const table = String(data.game.table || "");
        if (isGatesTableId(table)) {
          STATE.gatesOlympus = true;
          STATE.roulette_table = table;
        }
      }
    }

    function harvestGatesFromRaw(raw) {
      if (typeof raw !== "string" || !raw) return;
      if (!/gorRng|bonusNo|luckyMul|gatesofolympus/i.test(raw)) return;
      try {
        const data = JSON.parse(raw);
        harvestGatesFromObject(data);
      } catch (e) {
        // Regex fallback for bonusNo
        const m = raw.match(/"bonusNo"\s*:\s*(\d{1,2})/);
        if (m) {
          const n = Number(m[1]);
          if (Number.isInteger(n) && n >= 0 && n <= 36) {
            STATE.gatesBonusNumber = n;
            STATE.gatesOlympus = true;
          }
        }
      }
    }

    function clearLuckyForNewRound() {
      STATE.gatesLucky = {};
      STATE.gatesBonusNumber = null;
      STATE._gatesResultMul = null;
    }

    // --- Cross-frame bet book (TM substitute for mitmproxy unified STATE) ---

    function persistSharedBets(reason) {
      const payload = {
        bets: STATE.roulette_bets.map((b) => ({
          betCode: String(b.betCode),
          amount: Number(b.amount) || 0,
        })),
        table: STATE.roulette_table || "",
        gates: !!STATE.gatesOlympus,
        lucky: { ...STATE.gatesLucky },
        bonusNumber: STATE.gatesBonusNumber,
        at: Date.now(),
        reason: reason || "",
        frameId: FRAME_ID,
      };
      try {
        localStorage.setItem(SHARED_BETS_KEY, JSON.stringify(payload));
      } catch (e) {
      }
      try {
        if (__bc) __bc.postMessage({ type: "bets", ...payload });
      } catch (e) {
      }
      postToParent({ type: "LIVE_CASINO_BETS", ...payload });
      if (payload.bets.length) {
        LOG("shared bets saved", { count: payload.bets.length, reason, table: payload.table });
      }
    }

    function clearSharedBets() {
      try {
        localStorage.removeItem(SHARED_BETS_KEY);
      } catch (e) {
      }
      postToParent({ type: "LIVE_CASINO_BETS", bets: [], table: STATE.roulette_table || "", cleared: true });
    }

    function applyBetsPayload(payload, source) {
      if (!payload || !Array.isArray(payload.bets)) return 0;
      if (payload.cleared) {
        STATE.roulette_bets = [];
        return 0;
      }
      let added = 0;
      payload.bets.forEach((bet) => {
        if (!bet || bet.betCode == null) return;
        const code = String(bet.betCode);
        const amt = Number(bet.amount) || 0;
        const dup = STATE.roulette_bets.some(
          (b) => b.betCode === code && Math.abs(Number(b.amount) - amt) < 0.001
        );
        if (dup) return;
        STATE.roulette_bets.push({ betCode: code, amount: amt, at: Date.now(), synced: true });
        added += 1;
      });
      if (payload.table) {
        STATE.roulette_table = String(payload.table);
        if (isGatesTableId(payload.table)) STATE.gatesOlympus = true;
      }
      if (payload.gates) STATE.gatesOlympus = true;
      if (payload.lucky && typeof payload.lucky === "object") {
        Object.keys(payload.lucky).forEach((k) => {
          const m = Number(payload.lucky[k]);
          if (Number.isFinite(m) && m >= 2) STATE.gatesLucky[Number(k) || k] = m;
        });
      }
      if (payload.bonusNumber != null) {
        const n = Number(payload.bonusNumber);
        if (Number.isInteger(n) && n >= 0 && n <= 36) STATE.gatesBonusNumber = n;
      }
      if (added) LOG("bets from relay", { source, added, total: STATE.roulette_bets.length });
      return added;
    }

    function loadSharedBetsIntoState() {
      try {
        const raw = localStorage.getItem(SHARED_BETS_KEY);
        if (!raw) return 0;
        return applyBetsPayload(JSON.parse(raw), "localStorage");
      } catch (e) {
        return 0;
      }
    }

    function publishRouletteResult(resultNum, resultColor, gameId, table) {
      const payload = {
        type: "result",
        resultNum: Number(resultNum),
        color: String(resultColor || ""),
        gameId: String(gameId || ""),
        table: String(table || STATE.roulette_table || ""),
        lucky: { ...STATE.gatesLucky },
        bonusNumber: STATE.gatesBonusNumber,
        at: Date.now(),
      };
      try {
        localStorage.setItem("larp_live_last_result", JSON.stringify(payload));
      } catch (e) {
      }
      try {
        if (__bc) __bc.postMessage({ ...payload, frameId: FRAME_ID });
      } catch (e) {
      }
      postToParent({ type: "LIVE_CASINO_RESULT", ...payload });
      LOG("result published", payload);
    }

    function handleRelayedResult(payload, source) {
      if (!payload || !Number.isInteger(Number(payload.resultNum))) return false;
      if (payload.lucky && typeof payload.lucky === "object") {
        Object.keys(payload.lucky).forEach((k) => {
          const m = Number(payload.lucky[k]);
          if (Number.isFinite(m) && m >= 2) STATE.gatesLucky[Number(k) || k] = m;
        });
      }
      if (payload.bonusNumber != null) {
        const n = Number(payload.bonusNumber);
        if (Number.isInteger(n) && n >= 0 && n <= 36) {
          STATE.gatesBonusNumber = n;
          STATE.gatesOlympus = true;
        }
      }
      if (Array.isArray(payload.bets) && payload.bets.length) {
        applyBetsPayload(payload, source || "relay-with-bets");
      }
      loadSharedBetsIntoState();
      if (!STATE.roulette_bets.length) {
        LOG("relayed result but no bets yet", { source, resultNum: payload.resultNum });
        return false;
      }
      return settleRouletteBets(
        Number(payload.resultNum),
        String(payload.color || ""),
        String(payload.gameId || `relay:${payload.resultNum}`),
        String(payload.table || STATE.roulette_table || "")
      );
    }

    if (__bc) {
      __bc.onmessage = (event) => {
        const msg = event && event.data;
        if (!msg || msg.frameId === FRAME_ID) return;
        try {
          if (msg.type === "bets" && Array.isArray(msg.bets)) {
            applyBetsPayload(msg, "broadcast");
          }
          if (msg.type === "result" && Number.isInteger(Number(msg.resultNum))) {
            handleRelayedResult(msg, "broadcast");
          }
        } catch (e) {
        }
      };
    }

    window.addEventListener("message", (event) => {
      const data = event && event.data;
      if (!data || data[BRIDGE] !== true) return;

      // Fan-out into nested pragmatic iframes (Shuffle parent only reaches the outer frame).
      if (
        data.type === "LIVE_CASINO_BETS"
        || data.type === "LIVE_CASINO_RESULT"
        || data.type === "LIVE_CASINO_LUCKY"
        || data.type === "BALANCE_SYNC"
        || data.type === "GAME_CONTEXT"
      ) {
        try {
          const hop = Number(data._larpHop) || 0;
          if (hop < 4) {
            const next = { ...data, _larpHop: hop + 1 };
            document.querySelectorAll("iframe").forEach((frame) => {
              try {
                if (frame.contentWindow && frame.contentWindow !== event.source) {
                  frame.contentWindow.postMessage(next, "*");
                }
              } catch (e) {
              }
            });
          }
        } catch (e) {
        }
      }

      if (data.type === "GAME_CONTEXT") {
        const slug = String(data.slug || data.gameSlug || data.title || "").toLowerCase();
        if (/gates|olympus|gohroulette/.test(slug)) setGates(true);
        if (/roulette/.test(slug)) STATE._forceRoulette = true;
        return;
      }
      if (data.type === "LIVE_CASINO_BETS") {
        applyBetsPayload(data, "parent-relay");
        return;
      }
      if (data.type === "LIVE_CASINO_RESULT") {
        handleRelayedResult(data, "parent-relay");
        return;
      }
      if (data.type === "LIVE_CASINO_LUCKY") {
        if (data.lucky && typeof data.lucky === "object") {
          Object.keys(data.lucky).forEach((k) => {
            const m = Number(data.lucky[k]);
            if (Number.isFinite(m) && m >= 2) STATE.gatesLucky[Number(k) || k] = m;
          });
        }
        if (data.bonusNumber != null) {
          const n = Number(data.bonusNumber);
          if (Number.isInteger(n) && n >= 0 && n <= 36) STATE.gatesBonusNumber = n;
        }
        return;
      }
      if (data.type === "BALANCE_SYNC") {
        if (STATE._ignoreBalanceSyncUntil && Date.now() < STATE._ignoreBalanceSyncUntil) return;
        const fromUsd = Number(data.balanceUsd);
        const next = Number.isFinite(fromUsd) && fromUsd >= 0 ? fromUsd : null;
        if (next != null) {
          STATE.balance = next;
          try {
            localStorage.setItem(BAL_KEY, String(next));
          } catch (e) {
          }
          LOG("balance sync", next);
        }
      }
    });

    // --- Payout math (proxy parity) ---

    function getSplitPair(idx) {
      if (idx < 3) return [0, idx + 1];
      idx -= 3;
      if (idx < 24) {
        const row = Math.floor(idx / 2);
        const pos = idx % 2;
        const n = row * 3 + pos + 1;
        return [n, n + 1];
      }
      idx -= 24;
      if (idx < 33) {
        const n = idx + 1;
        return [n, n + 3];
      }
      return null;
    }

    function getCornerNums(idx) {
      if (idx < 0 || idx > 22) return null;
      const row = Math.floor(idx / 2);
      const col = idx % 2;
      const topLeft = row * 3 + col + 1;
      if (topLeft + 4 > 36) return null;
      return [topLeft, topLeft + 1, topLeft + 3, topLeft + 4];
    }

    function calcBac(betcode, amount, winner) {
      const bc = String(betcode);
      if (bc === "0") {
        if (winner === "PLAYER") return amount * 2;
        if (winner === "TIE") return amount;
      } else if (bc === "1") {
        if (winner === "BANKER") return amount * 1.95;
        if (winner === "TIE") return amount;
      } else if (bc === "2") {
        if (winner === "TIE") return amount * 9;
      } else if (bc === "3") {
        if (winner === "PLAYER_PAIR") return amount * 12;
      } else if (bc === "4") {
        if (winner === "BANKER_PAIR") return amount * 12;
      } else if (bc === "5") {
        if (winner === "PERFECT_PAIR") return amount * 26;
      } else if (bc === "6") {
        if (winner === "PLAYER_PAIR" || winner === "BANKER_PAIR") return amount * 6;
      } else if (bc === "9") {
        if (winner === "BIG") return amount * 1.5;
      } else if (bc === "10") {
        if (winner === "SMALL") return amount * 2.5;
      }
      return 0;
    }

    function calcRoulette(betcode, amount, resultNum, resultColor, table) {
      const bc = String(betcode);
      const amt = Number(amount) || 0;
      if (!(amt > 0) || !Number.isInteger(resultNum)) return 0;
      const sm = straightMult(resultNum, table);

      if (bc === "2") return resultNum === 0 ? amt * sm : 0;
      if (/^\d+$/.test(bc) && Number(bc) >= 4 && Number(bc) <= 39) {
        return resultNum === Number(bc) - 3 ? amt * sm : 0;
      }
      if (bc === "40") return resultNum >= 1 && resultNum <= 12 ? amt * 3 : 0;
      if (bc === "41") return resultNum >= 13 && resultNum <= 24 ? amt * 3 : 0;
      if (bc === "42") return resultNum >= 25 && resultNum <= 36 ? amt * 3 : 0;
      if (bc === "43") return resultNum > 0 && resultNum % 3 === 1 ? amt * 3 : 0;
      if (bc === "44") return resultNum > 0 && resultNum % 3 === 2 ? amt * 3 : 0;
      if (bc === "45") return resultNum > 0 && resultNum % 3 === 0 ? amt * 3 : 0;
      if (bc === "46") return resultNum >= 1 && resultNum <= 18 ? amt * 2 : 0;
      if (bc === "47") return resultNum !== 0 && resultNum % 2 === 0 ? amt * 2 : 0;
      if (bc === "48") return ROULETTE_RED.has(resultNum) ? amt * 2 : 0;
      if (bc === "49") return ROULETTE_BLACK.has(resultNum) ? amt * 2 : 0;
      if (bc === "50") return resultNum !== 0 && resultNum % 2 === 1 ? amt * 2 : 0;
      if (bc === "51") return resultNum >= 19 && resultNum <= 36 ? amt * 2 : 0;
      if (/^\d+$/.test(bc) && Number(bc) >= 52 && Number(bc) <= 108) {
        const pair = getSplitPair(Number(bc) - 52);
        return pair && pair.includes(resultNum) ? amt * 18 : 0;
      }
      if (/^\d+$/.test(bc) && Number(bc) >= 109 && Number(bc) <= 130) {
        const corner = getCornerNums(Number(bc) - 109);
        return corner && corner.includes(resultNum) ? amt * 9 : 0;
      }
      if (/^\d+$/.test(bc) && Number(bc) >= 131 && Number(bc) <= 142) {
        const start = (Number(bc) - 131) * 3 + 1;
        return [start, start + 1, start + 2].includes(resultNum) ? amt * 12 : 0;
      }
      if (/^\d+$/.test(bc) && Number(bc) >= 143 && Number(bc) <= 153) {
        const start = (Number(bc) - 143) * 3 + 1;
        return resultNum >= start && resultNum < start + 6 ? amt * 6 : 0;
      }
      return 0;
    }

    function deepFindKey(node, keyNames, depth) {
      if (!node || typeof node !== "object" || depth > 10) return null;
      if (Array.isArray(node)) {
        for (let i = 0; i < node.length; i += 1) {
          const hit = deepFindKey(node[i], keyNames, depth + 1);
          if (hit) return hit;
        }
        return null;
      }
      for (let i = 0; i < keyNames.length; i += 1) {
        if (node[keyNames[i]] != null) return { key: keyNames[i], value: node[keyNames[i]] };
      }
      const keys = Object.keys(node);
      for (let i = 0; i < keys.length; i += 1) {
        const hit = deepFindKey(node[keys[i]], keyNames, depth + 1);
        if (hit) return hit;
      }
      return null;
    }

    function parseIncomingEnvelope(raw) {
      let data;
      try {
        data = JSON.parse(raw);
      } catch (e) {
        return null;
      }
      if (typeof data === "string") {
        try {
          data = JSON.parse(data);
        } catch (e) {
          return null;
        }
      }
      if (!data || typeof data !== "object") return null;
      ["payload", "msg", "message", "data", "body", "args", "params"].forEach((key) => {
        if (!data || typeof data !== "object") return;
        let inner = data[key];
        if (typeof inner === "string") {
          try {
            inner = JSON.parse(inner);
          } catch (e) {
            return;
          }
        }
        if (inner && typeof inner === "object") data = { ...data, ...inner };
      });
      return data;
    }

    function acceptRouletteBet(betcode, amount, table, seq, source) {
      const amt = Number(amount) || 0;
      if (!(amt > 0)) return null;
      if (table) {
        STATE.roulette_table = String(table);
        if (isGatesTableId(table)) STATE.gatesOlympus = true;
      }
      const already = STATE.roulette_bets.some(
        (b) => b.betCode === String(betcode) && Math.abs(Number(b.amount) - amt) < 0.001
      );
      if (!already) {
        STATE.roulette_bets.push({ betCode: String(betcode), amount: amt });
        if (source !== "outgoing-dup") {
          const recentOut = STATE._lastOutBetAt
            && Date.now() - STATE._lastOutBetAt < 2500
            && STATE._lastOutBetCode === String(betcode);
          if (!recentOut) setBalance(getBalance() - amt);
        }
      }
      LOG("bet accept", { betcode, amount: amt, table, source, bets: STATE.roulette_bets.length, gates: gatesMode(table) });
      if (source === "reject") STATE._lastRejectAcceptAt = Date.now();
      persistSharedBets(source || "accept");
      return JSON.stringify({
        bet: {
          bc: "true",
          amount: String(amt),
          betcode: String(betcode),
          table: String(table || ""),
          seq: seq || nextSeq(),
        },
      });
    }

    /** Mirror live_casino_proxy gameresult settle */
    function settleRouletteBets(resultNum, resultColor, gameId, table) {
      loadSharedBetsIntoState();
      if (!STATE.roulette_bets.length) return false;
      if (!Number.isInteger(resultNum) || resultNum < 0 || resultNum > 36) return false;

      const settleKey = String(gameId || `${table || STATE.roulette_table || "rou"}:${resultNum}`);
      if (settleKey && settleKey === STATE._last_roulette_gid) return false;

      try {
        const claimKey = `larp_settle_${settleKey}`;
        if (localStorage.getItem(claimKey)) {
          LOG("settle already claimed", settleKey);
          STATE._last_roulette_gid = settleKey;
          STATE.roulette_bets = [];
          clearSharedBets();
          return false;
        }
        localStorage.setItem(claimKey, String(Date.now()));
      } catch (e) {
      }

      STATE._last_roulette_gid = settleKey;
      if (table) {
        STATE.roulette_table = table;
        if (isGatesTableId(table)) STATE.gatesOlympus = true;
      }

      const bets = STATE.roulette_bets.slice();
      STATE.roulette_bets = [];
      clearSharedBets();

      let totalPayout = 0;
      bets.forEach((bet) => {
        totalPayout += calcRoulette(bet.betCode, bet.amount, resultNum, resultColor, table || STATE.roulette_table);
      });

      if (totalPayout > 0) {
        setBalance(getBalance() + totalPayout);
        STATE._ignoreBalanceSyncUntil = Date.now() + 8000;
      }

      STATE._roulette_pending_win = {
        gameId: settleKey,
        payout: totalPayout,
        table: table || STATE.roulette_table || "",
      };

      LOG("roulette settle", {
        resultNum,
        totalPayout,
        bets,
        gates: gatesMode(table),
        straightMult: straightMult(resultNum, table),
        lucky: STATE.gatesLucky[resultNum] || null,
        bonusNumber: STATE.gatesBonusNumber,
        frame: FRAME_ID,
      });
      return true;
    }

    function trackOutgoingRouletteBets(data, raw) {
      const found = [];
      const visit = (node, depth) => {
        if (!node || typeof node !== "object" || depth > 8) return;
        if (Array.isArray(node)) {
          node.forEach((item) => visit(item, depth + 1));
          return;
        }
        const betcode = node.betCode ?? node.betcode ?? node.code;
        const amount = node.amount ?? node.stake ?? node.value ?? node.betAmount;
        if (betcode != null && amount != null) {
          const codeNum = Number(betcode);
          let amt = Number(amount);
          if (Number.isFinite(amt) && amt > 0) {
            if (amt > 1000 && Number.isInteger(amt)) amt /= 100;
            if (codeNum === 2 || (codeNum >= 4 && codeNum <= 153) || gatesMode() || STATE._forceRoulette) {
              found.push({
                betCode: String(betcode),
                amount: amt,
                table: String(node.table || node.tableId || STATE.roulette_table || ""),
              });
            }
          }
        }
        Object.keys(node).forEach((key) => {
          if (node[key] && typeof node[key] === "object") visit(node[key], depth + 1);
        });
      };
      visit(data, 0);

      found.forEach((bet) => {
        const dup = STATE.roulette_bets.some(
          (b) => b.betCode === bet.betCode && Math.abs(Number(b.amount) - Number(bet.amount)) < 0.001
        );
        if (dup) return;
        STATE.roulette_bets.push({ betCode: bet.betCode, amount: bet.amount });
        STATE._lastOutBetAt = Date.now();
        STATE._lastOutBetCode = String(bet.betCode);
        if (bet.table) {
          STATE.roulette_table = bet.table;
          if (isGatesTableId(bet.table)) STATE.gatesOlympus = true;
        }
        setBalance(getBalance() - Number(bet.amount));
        LOG("bet tracked (outgoing)", bet);
        persistSharedBets("outgoing");
      });
    }

    function detectBjDecision(raw, data) {
      try {
        const actionNames = { hit: "hit", stand: "stand", double: "double", "double down": "double", split: "split" };
        const s = String(raw || "");
        if (data && typeof data === "object") {
          const decision = data.decision && typeof data.decision === "object"
            ? data.decision
            : data.gameEvent && typeof data.gameEvent === "object"
              ? data.gameEvent
              : null;
          const exact = [data.action, data.dec, decision && decision.dec, decision && decision.action]
            .map((v) => String(v == null ? "" : v).toLowerCase().trim());
          for (const c of exact) {
            if (c && actionNames[c]) return actionNames[c];
          }
          if (decision && decision.value) {
            const v = String(decision.value).toLowerCase();
            const m = v.match(/(hit|stand|double down|double|split)/);
            if (m) return actionNames[m[1]] || (m[1] === "double down" ? "double" : m[1]);
          }
        }
        const xm = s.match(/<\s*decision\b[^>]*\bdec\s*=\s*["']([^"']+)["']/i);
        if (xm) {
          const a = String(xm[1]).toLowerCase().trim();
          return actionNames[a] || null;
        }
      } catch (e) {
      }
      return null;
    }

    function handleOutgoing(raw) {
      if (typeof raw !== "string" || !raw) return raw;
      let data = null;
      try {
        data = JSON.parse(raw);
      } catch (e) {
      }

      if (STATE.bj_active) {
        const action = detectBjDecision(raw, data);
        if (action) {
          if (STATE._bj_inject_decision_confirm) {
            return JSON.stringify({ cmd: "ping", counter: 0, clientTime: Date.now() });
          }
          LOG("bj decision captured", { action, raw: String(raw).slice(0, 240) });
          STATE.bj_decided = true;
          STATE._bj_player_action = action;
          STATE._bj_last_ack_action = action;
          const valueMap = {
            stand: "Decision: Stand",
            hit: "Decision: Hit",
            double: "Decision: Double Down",
            split: "Decision: Split",
          };
          STATE._bj_inject_decision_confirm = {
            decision: {
              game: STATE.bj_game_id || "",
              code: "101",
              action: "playerCall",
              place: "1",
              userId: STATE.user_id,
              hand: "0",
              seq: nextSeq(),
              value: valueMap[action] || "Decision: Stand",
            },
          };
          return JSON.stringify({ cmd: "ping", counter: 0, clientTime: Date.now() });
        }
        if (data && typeof data === "object" && (data.decision || data.dec || data.action || /decision|"dec"|\bdec\s*=|\bdec\s*:/i.test(raw))) {
          LOG("bj outgoing frame", { raw: String(raw).slice(0, 240), keys: Object.keys(data).slice(0, 14) });
        }
      }

      if (!data || typeof data !== "object") return raw;

      try {
        trackOutgoingRouletteBets(data, raw);
      } catch (e) {
      }

      return raw;
    }

    function patchBalanceFields(node, bal, depth) {
      if (!node || typeof node !== "object" || depth > 8) return false;
      let changed = false;
      const balStr = Number(bal).toFixed(2);
      if (Array.isArray(node)) {
        node.forEach((item) => {
          if (patchBalanceFields(item, bal, (depth || 0) + 1)) changed = true;
        });
        return changed;
      }
      Object.keys(node).forEach((key) => {
        if (/^(balance|totalBalance|availableBalance|cash|userBalance|walletBalance|balanceAmount)$/i.test(key)) {
          if (typeof node[key] === "number") {
            node[key] = Number(bal);
            changed = true;
          } else if (typeof node[key] === "string" && /^-?\d/.test(node[key])) {
            node[key] = balStr;
            changed = true;
          }
        } else if (node[key] && typeof node[key] === "object") {
          if (patchBalanceFields(node[key], bal, (depth || 0) + 1)) changed = true;
        }
      });
      return changed;
    }

    function rewriteWalletBalanceText(text) {
      try {
        const data = JSON.parse(text);
        if (data && typeof data === "object" && patchBalanceFields(data, getBalance(), 0)) {
          return JSON.stringify(data);
        }
      } catch (e) {
      }
      return text;
    }

    function buildBjDecisioninc(score, dealerScore, gameId) {
      const now = new Date();
      const timer = [
        String(now.getHours()).padStart(2, "0"),
        String(now.getMinutes()).padStart(2, "0"),
        String(now.getSeconds()).padStart(2, "0"),
      ].join(":");
      const playerScore = Number(score) || 17;
      const dScore = Number(dealerScore) || 5;
      return JSON.stringify({
        decisioninc: {
          score: String(playerScore),
          timer,
          game: gameId || "",
          cansplit: "false",
          dealerscore: String(dScore),
          time: "15",
          candouble: playerScore <= 11 ? "true" : "false",
          userId: STATE.user_id,
          hand: "0",
          seq: nextSeq(),
        },
      });
    }

    function handleIncoming(raw) {
      if (typeof raw !== "string" || !raw) return raw;

      const data = parseIncomingEnvelope(raw);
      if (!data) {
        harvestGatesFromRaw(raw);
        return raw;
      }

      harvestGatesFromObject(data);
      harvestGatesFromRaw(raw);

      // BJ: re-open the Hit/Stand menu after a Hit was locally acked.
      // Injected on the next safe frame so it works even if the server never
      // re-sends onebj_player_stats for this fake seat.
      if (STATE._bj_force_reoffer && STATE.bj_active && !STATE.bj_decided) {
        if (!data.onebj_result && !data.onebj_game_end && !data.gameresult && !data.gameResult && !data.win && !data.betValidationError && !data.bets && !data.betsopen && !data.startBetting) {
          STATE._bj_force_reoffer = false;
          STATE._bj_decision_sent = true;
          LOG("bj re-offer after hit", { score: STATE.bj_player_score, dealer: STATE.bj_dealer_score });
          return buildBjDecisioninc(STATE.bj_player_score, STATE.bj_dealer_score, STATE.bj_game_id);
        }
      }

      // New betting window / Gates game start → clear lucky map for the next round.
      if (
        data.startBetting || data.bettingOpen || data.startGame || data.tableState === "BETS_OPEN"
        || (data.game && data.game.table && isGatesTableId(data.game.table))
      ) {
        // gorRng arrives after game start — only clear on game id change.
        if (data.game && data.game.id && data.game.id !== STATE._gatesGameId) {
          STATE._gatesGameId = String(data.game.id);
          clearLuckyForNewRound();
        } else if (!data.game) {
          clearLuckyForNewRound();
        }
      }

      let bal = getBalance();

      // BJ decision confirm inject — deliver on the next safe frame, not only onebj_player_stats
      if (STATE._bj_inject_decision_confirm && !STATE._bj_pending_payout && !data.onebj_game_end && !data.onebj_result) {
        const confirm = STATE._bj_inject_decision_confirm;
        const ackAction = STATE._bj_last_ack_action;
        STATE._bj_inject_decision_confirm = null;
        delete STATE._bj_last_ack_action;
        if (ackAction === "hit") {
          const hitCards = [2, 3, 4, 5, 6, 7, 8, 9, 10, 10, 10, 10, 11];
          STATE.bj_player_score = (Number(STATE.bj_player_score) || 0) + hitCards[Math.floor(Math.random() * hitCards.length)];
          STATE.bj_decided = false;
          delete STATE._bj_decision_sent;
          STATE._bj_force_reoffer = true;
          LOG("bj hit acked, re-arming offer", { score: STATE.bj_player_score });
        }
        LOG("bj decision confirm delivered", { onFrame: Object.keys(data)[0] });
        return JSON.stringify(confirm);
      }

      // SoftSwiss win inject after gameresult — never replace video/camera control frames.
      if (STATE._roulette_pending_win && !data.gameresult && !data.gameResult && !data.win) {
        if (data.cameraEvent || data.game || data.gorRng || data.subscribe || data.pong || data.betsclosed) {
          // Keep pending; wait for winners / next safe frame.
        } else {
          const pending = STATE._roulette_pending_win;
          STATE._roulette_pending_win = null;
          const payout = Number(pending.payout) || 0;
          const table = pending.table || STATE.roulette_table || "gatesofolympus01";
          LOG("roulette win inject", pending);
          return JSON.stringify({
            win: {
              gameId: pending.gameId || "",
              megawin: "false",
              rewardtype: "CASH",
              mCap: "false",
              nwb: payout > 0 ? payout.toFixed(2) : "0",
              win: payout > 0 ? payout.toFixed(2) : "0",
              table,
              seq: nextSeq(),
            },
          });
        }
      }

      // BJ decision confirm inject (delivered earlier in handleIncoming)

      // BJ payout inject
      if (STATE._bj_pending_payout && !data.onebj_game_end && !data.onebj_result) {
        STATE._bj_pending_payout = false;
        const betAmount = STATE.bj_bet_amount || 0;
        const won = !!STATE._bj_won;
        const push = !!STATE._bj_push;
        delete STATE._bj_won;
        delete STATE._bj_push;
        delete STATE._bj_bust;
        bal = getBalance();
        let winMsg;
        if (won) {
          const payout = betAmount * 2;
          bal += payout;
          setBalance(bal);
          winMsg = {
            win: {
              gameId: STATE.bj_game_id || "",
              megawin: "false",
              rewardtype: "CASH",
              mCap: "false",
              nwb: bal.toFixed(2),
              win: payout.toFixed(2),
              table: STATE.bj_table || "",
              seq: nextSeq(),
            },
          };
        } else if (push) {
          const payout = betAmount;
          bal += payout;
          setBalance(bal);
          winMsg = {
            win: {
              gameId: STATE.bj_game_id || "",
              megawin: "false",
              rewardtype: "CASH",
              mCap: "false",
              nwb: bal.toFixed(2),
              win: payout.toFixed(2),
              table: STATE.bj_table || "",
              seq: nextSeq(),
            },
          };
        } else {
          winMsg = {
            win: {
              gameId: STATE.bj_game_id || "",
              megawin: "false",
              rewardtype: "CASH",
              mCap: "false",
              nwb: bal.toFixed(2),
              win: "0.0",
              table: STATE.bj_table || "",
              seq: nextSeq(),
            },
          };
        }
        STATE.bj_decided = false;
        STATE.bj_game_id = "";
        STATE.bj_bet_amount = 0;
        delete STATE._bj_decision_sent;
        delete STATE._bj_player_action;
        return JSON.stringify(winMsg);
      }

      // betValidationError → fake accept (proxy parity)
      {
        const rejectHit = data.betValidationError
          ? { value: data.betValidationError }
          : deepFindKey(data, ["betValidationError", "betError", "validationError"], 0);
        const error = rejectHit && rejectHit.value && typeof rejectHit.value === "object"
          ? rejectHit.value
          : null;
        if (error && (error.betCode != null || error.betcode != null || error.amount != null)) {
          const betcode = String(error.betCode ?? error.betcode ?? error.code ?? "0");
          const amount = Number(error.amount || error.stake || 0);
          const table = String(error.table || error.tableId || STATE.roulette_table || "");
          const seq = error.seq || 0;
          let codeNum = Number(betcode);
          if (!Number.isFinite(codeNum)) codeNum = 0;

          if (isGatesTableId(table)) {
            STATE.gatesOlympus = true;
            STATE.roulette_table = table;
          }

          const isRouletteCode = codeNum === 2 || (codeNum >= 4 && codeNum <= 153);
          const isBlackjack = betcode === "101" || (STATE.bj_table && table === STATE.bj_table);
          const pageLooksRoulette = STATE._forceRoulette
            || gatesMode(table)
            || /roulette|olympus|gatesofolympus/i.test(`${document.title} ${location.href} ${table}`);

          if (isBlackjack && amount > 0) {
            STATE.bj_table = table;
            STATE.bj_bet_amount = amount;
            STATE.bj_active = true;
            STATE.bj_decided = false;
            delete STATE._bj_decision_sent;
            setBalance(getBalance() - amount);
            LOG("bj accept", { betcode, amount, table });
            return JSON.stringify({ bet: { amount: String(amount), betcode, tableId: table, seq } });
          }

          if ((pageLooksRoulette || isRouletteCode) && amount > 0) {
            const accepted = acceptRouletteBet(betcode, amount, table || "gatesofolympus01", seq, "reject");
            if (accepted) return accepted;
          } else if (amount > 0) {
            STATE.table_id = table;
            STATE.pending_bets.push({ betCode: betcode, amount });
            setBalance(getBalance() - amount);
            LOG("bet accept", { betcode, amount, table, isRoulette: false });
            return JSON.stringify({
              bet: { bc: "true", amount: String(amount), betcode, table, seq },
            });
          }
        }
      }

      // Gates real traffic: server echoes accepted chips as {"bets":{"bet":[{amount,betcode,...}]}}
      // Track those when we didn't already capture via betValidationError (LARP reject path).
      if (data.bets && typeof data.bets === "object") {
        const list = Array.isArray(data.bets.bet) ? data.bets.bet : [];
        if (list.length) {
          STATE.roulette_table = STATE.roulette_table || "gatesofolympus01";
          if (/olympus|gates/i.test(document.title + location.href)) STATE.gatesOlympus = true;
          list.forEach((b) => {
            if (!b) return;
            const betcode = String(b.betcode ?? b.betCode ?? "");
            const amount = Number(b.amount || 0);
            if (!betcode || !(amount > 0)) return;
            const dup = STATE.roulette_bets.some(
              (x) => x.betCode === betcode && Math.abs(Number(x.amount) - amount) < 0.001
            );
            if (dup) return;
            STATE.roulette_bets.push({ betCode: betcode, amount });
            // Real server already deducted; for LARP-only echoes after reject-accept, skip double deduct.
            if (!STATE._lastRejectAcceptAt || Date.now() - STATE._lastRejectAcceptAt > 3000) {
              setBalance(getBalance() - amount);
            }
            LOG("bet tracked (bets echo)", { betcode, amount, desc: b.description });
          });
          persistSharedBets("bets-echo");
        }
      }

      // Baccarat betstats
      if (data.betstats && STATE.pending_bets.length) {
        const stats = data.betstats;
        const table = stats.table || "";
        if (table === STATE.table_id) {
          STATE.pending_bets.forEach((bet) => {
            const bc = bet.betCode;
            const amt = bet.amount;
            if (bc === "0") {
              stats.playertotal = String(Number(stats.playertotal || 0) + amt);
              stats.playercount = String(Number(stats.playercount || 0) + 1);
            } else if (bc === "1") {
              stats.bankertotal = String(Number(stats.bankertotal || 0) + amt);
              stats.bankercount = String(Number(stats.bankercount || 0) + 1);
            } else if (bc === "2") {
              stats.tietotal = String(Number(stats.tietotal || 0) + amt);
              stats.tiecount = String(Number(stats.tiecount || 0) + 1);
            }
            stats.totalBetscount = String(Number(stats.totalBetscount || 0) + 1);
          });
          const total = Number(stats.playertotal || 0) + Number(stats.bankertotal || 0) + Number(stats.tietotal || 0);
          if (total > 0) {
            stats.playerpercentage = ((Number(stats.playertotal || 0) / total) * 100).toFixed(1);
            stats.bankerpercentage = ((Number(stats.bankertotal || 0) / total) * 100).toFixed(1);
            stats.tiepercentage = ((Number(stats.tietotal || 0) / total) * 100).toFixed(1);
          }
          return JSON.stringify(data);
        }
      }

      // Baccarat ShoeSummary
      if (data.ShoeSummary && STATE.pending_bets.length) {
        const summary = data.ShoeSummary;
        const table = summary.table || "";
        if (table !== STATE.table_id) return raw;
        const p = Number(summary.playerWinCounter || 0);
        const b = Number(summary.bankerWinCounter || 0);
        const t = Number(summary.tieCounter || 0);
        if (p < STATE.prev_player_wins || b < STATE.prev_banker_wins || t < STATE.prev_tie_count) {
          STATE.prev_player_wins = p;
          STATE.prev_banker_wins = b;
          STATE.prev_tie_count = t;
          return raw;
        }
        let winner = null;
        if (STATE.prev_player_wins >= 0) {
          if (p > STATE.prev_player_wins) winner = "PLAYER";
          else if (b > STATE.prev_banker_wins) winner = "BANKER";
          else if (t > STATE.prev_tie_count) winner = "TIE";
        }
        STATE.prev_player_wins = p;
        STATE.prev_banker_wins = b;
        STATE.prev_tie_count = t;
        if (winner) {
          const totalPayout = STATE.pending_bets.reduce(
            (sum, bet) => sum + calcBac(bet.betCode, bet.amount, winner),
            0
          );
          STATE.pending_bets = [];
          STATE.last_bac_payout = totalPayout;
          LOG("baccarat settle", { winner, totalPayout });
          return JSON.stringify({
            win: {
              gameId: "",
              megawin: "false",
              rewardtype: "CASH",
              mCap: "false",
              nwb: (bal + totalPayout - 10000).toFixed(3),
              win: totalPayout.toFixed(2),
              table,
              seq: nextSeq(),
            },
          });
        }
      }

      if (data.ShoeSummary && !STATE.pending_bets.length) {
        const summary = data.ShoeSummary;
        const table = summary.table || "";
        if (table === STATE.table_id || !STATE.table_id) {
          STATE.prev_player_wins = Number(summary.playerWinCounter || 0);
          STATE.prev_banker_wins = Number(summary.bankerWinCounter || 0);
          STATE.prev_tie_count = Number(summary.tieCounter || 0);
          if (!STATE.table_id) STATE.table_id = table;
        }
      }

      if (data.winners && typeof data.winners === "object") {
        const winners = data.winners;
        const table = winners.table || "";
        if (table === STATE.table_id && STATE.last_bac_payout > 0) {
          const payout = STATE.last_bac_payout;
          bal = getBalance() + payout;
          setBalance(bal);
          const list = Array.isArray(winners.winner) ? winners.winner.slice() : [];
          list.unshift({
            megawin: "false",
            currency: "USD",
            screenName: "AthleticRobin4494",
            userId: STATE.user_id,
            win: payout.toFixed(2),
          });
          winners.winner = list;
          winners.winnersCount = String(Number(winners.winnersCount || 0) + 1);
          winners.totalEur = (Number(winners.totalEur || 0) + payout).toFixed(4);
          if (payout > Number(winners.topWin || 0)) winners.topWin = payout.toFixed(4);
          STATE.last_bac_payout = 0;
          return JSON.stringify(data);
        }
      }

      // ONE Blackjack
      if (data.game && typeof data.game === "object" && STATE.bj_active) {
        const gameInfo = data.game;
        const table = gameInfo.table || "";
        if (STATE.bj_table && table === STATE.bj_table) {
          STATE.bj_game_id = gameInfo.id || "";
          STATE.bj_decided = false;
          delete STATE._bj_decision_sent;
          delete STATE._bj_player_action;
        }
      }

      if (data.onebj_player_stats && STATE.bj_active && !STATE.bj_decided) {
        const stats = data.onebj_player_stats;
        const gameId = stats.gameId || "";
        const pending = Number(stats.totalpending || 0);
        const totalHands = Number(stats.totalhands || 0);
        const totalDone = Number(stats.totaldone || 0);
        if (pending > 0 && pending === totalHands && totalDone === 0 && !STATE._bj_decision_sent) {
          STATE.bj_game_id = gameId;
          STATE._bj_decision_sent = true;
          LOG("bj decisioninc injected", { gameId, pending, totalHands, totalDone });
          const scores = [17, 18, 19, 20, 12, 13, 14, 15, 16, 11];
          const dealerScores = [2, 3, 4, 5, 6, 7, 8, 9, 10];
          const playerScore = STATE.bj_player_score || scores[Math.floor(Math.random() * scores.length)];
          const dealerScore = STATE.bj_dealer_score || dealerScores[Math.floor(Math.random() * dealerScores.length)];
          STATE.bj_player_score = playerScore;
          STATE.bj_dealer_score = dealerScore;
          return buildBjDecisioninc(playerScore, dealerScore, gameId);
        }
      }

      if (data.onebj_player_stats && STATE.bj_active && STATE._bj_decision_sent && !STATE.bj_decided) {
        const stats = data.onebj_player_stats;
        const pending = Number(stats.totalpending || 0);
        const totalDone = Number(stats.totaldone || 0);
        const totalHands = Number(stats.totalhands || 0);
        if (pending === 0 && totalDone >= totalHands - 1) {
          STATE.bj_decided = true;
          STATE._bj_player_action = "stand";
          return JSON.stringify({
            decision: {
              game: STATE.bj_game_id || "",
              code: "101",
              action: "playerCall",
              place: "1",
              userId: STATE.user_id,
              hand: "0",
              seq: nextSeq(),
              value: "Decision: Stand",
            },
          });
        }
      }

      if (data.onebj_result && STATE.bj_active) {
        const result = data.onebj_result;
        const totalLoss = Number(result.totalLoss || 0);
        const wins = Number(result.wins || 0);
        const pushCount = Number(result.push || 0);
        const playerAction = STATE._bj_player_action || "stand";
        let playerScore = STATE.bj_player_score || 19;
        const hitCards = [2, 3, 4, 5, 6, 7, 8, 9, 10, 10, 10, 10, 11];
        if (playerAction === "hit") {
          playerScore += hitCards[Math.floor(Math.random() * hitCards.length)];
          if (playerScore > 21) {
            STATE._bj_won = false;
            STATE._bj_bust = true;
          } else if (wins > totalLoss) STATE._bj_won = true;
          else if (pushCount > 0 && wins === 0) STATE._bj_push = true;
          else STATE._bj_won = false;
        } else if (playerAction === "double") {
          playerScore += hitCards[Math.floor(Math.random() * hitCards.length)];
          STATE.bj_bet_amount *= 2;
          if (playerScore > 21) {
            STATE._bj_won = false;
            STATE._bj_bust = true;
          } else STATE._bj_won = wins > totalLoss;
        } else if (wins > 0 && wins >= totalLoss) STATE._bj_won = true;
        else if (pushCount > 0 && wins === 0) STATE._bj_push = true;
        else STATE._bj_won = false;
        if (CONFIG.FORCE_BLACKJACK_WIN) {
          STATE._bj_win_counter = (STATE._bj_win_counter || 0) + 1;
          const wMin = Math.max(1, Number(CONFIG.BLACKJACK_WIN_ATTEMPTS_MIN) || 1);
          const wMax = Math.max(wMin, Number(CONFIG.BLACKJACK_WIN_ATTEMPTS_MAX) || 10);
          const winOn = wMin + Math.floor(Math.random() * (wMax - wMin + 1));
          if (STATE._bj_win_counter >= winOn) {
            STATE._bj_win_counter = 0;
            STATE._bj_won = true;
            STATE._bj_push = false;
            delete STATE._bj_bust;
            LOG("bj forced win", { winOn });
          }
        }
      }

      if (data.onebj_game_end && STATE.bj_active) {
        const gameEnd = data.onebj_game_end;
        const gameId = gameEnd.id || "";
        if (gameId === STATE.bj_game_id || !STATE.bj_game_id) STATE._bj_pending_payout = true;
      }

      // Gates gameresult uses `result` (not Speed's `score`). Also has mul / luckyWin.
      // Real examples:
      //   {"gameresult":{"result":6,"color":"black","mul":21.0,"luckyWin":false,"id":"...","resultBetCodeId":9}}
      //   {"win":{"gameId":"...","win":"0","table":"gatesofolympus01"}}           // loss
      //   {"win":{"gameId":"...","win":"0.20","table":"gatesofolympus01"}}        // 2x outside win
      const gr = data.gameresult || data.gameResult
        || deepFindKey(data, ["gameresult", "gameResult"], 0)?.value
        || null;
      if (gr && typeof gr === "object" && gr.gameType !== "baccarat") {
        const rawNum = gr.result != null ? gr.result : gr.score;
        if (rawNum != null) {
          const resultNum = Number.parseInt(String(rawNum), 10);
          const resultColor = String(gr.color || "").toLowerCase();
          const gameId = String(gr.id || "");
          let table = String(gr.table || STATE.roulette_table || "");
          if (!table && (gatesMode() || /olympus|gates/i.test(document.title))) {
            table = "gatesofolympus01";
          }
          const resultMul = Number(gr.mul);
          if (Number.isFinite(resultMul) && resultMul >= 2) {
            STATE._gatesResultMul = resultMul;
          }
          if (gr.luckyWin === true || gr.luckyWin === "true") {
            if (Number.isFinite(resultMul) && resultMul >= 2) {
              STATE.gatesLucky[resultNum] = resultMul;
            }
          }
          if (Number.isInteger(resultNum) && resultNum >= 0 && resultNum <= 36) {
            if (isGatesTableId(table) || Number.isFinite(resultMul)) STATE.gatesOlympus = true;
            if (table) STATE.roulette_table = table;
            const gid = gameId || `gr:${table}:${resultNum}`;
            LOG("gameresult", {
              resultNum,
              resultColor,
              mul: resultMul,
              luckyWin: gr.luckyWin,
              table,
              bets: STATE.roulette_bets.length,
            });
            publishRouletteResult(resultNum, resultColor, gid, table);
            loadSharedBetsIntoState();
            if (STATE.roulette_bets.length) {
              settleRouletteBets(resultNum, resultColor, gid, table);
            } else {
              LOG("result seen but no bets in this frame", { resultNum, table, frame: FRAME_ID });
            }
          } else if (table && !STATE.roulette_bets.length) {
            STATE.roulette_table = table;
          }
        }
      }

      // Spoof wallet fields on original envelope
      try {
        const forPatch = JSON.parse(raw);
        if (forPatch && typeof forPatch === "object" && patchBalanceFields(forPatch, getBalance(), 0)) {
          return JSON.stringify(forPatch);
        }
      } catch (e) {
      }
      return raw;
    }

    function coerceWsData(data) {
      if (typeof data === "string") return data;
      try {
        if (data instanceof ArrayBuffer) return new TextDecoder("utf-8").decode(data);
        if (ArrayBuffer.isView(data)) return new TextDecoder("utf-8").decode(data);
      } catch (e) {
      }
      return null;
    }

    function deliverRewrittenMessage(listener, ws, event, text) {
      try {
        const next = handleIncoming(text);
        if (typeof next !== "string") return listener.call(ws, event);
        try {
          const fakeEvent = new MessageEvent("message", {
            data: next,
            origin: event.origin,
            lastEventId: event.lastEventId,
            source: event.source,
            ports: event.ports,
          });
          return listener.call(ws, fakeEvent);
        } catch (e) {
          try {
            Object.defineProperty(event, "data", {
              configurable: true,
              enumerable: true,
              writable: true,
              value: next,
            });
            return listener.call(ws, event);
          } catch (e2) {
            return listener.call(ws, event);
          }
        }
      } catch (e) {
        return listener.call(ws, event);
      }
    }

    function wrapIncomingListener(listener) {
      return function (event) {
        const data = event && event.data;
        // Text SoftSwiss frames only. Never rewrite binary/Blob (video/broadcaster).
        if (typeof data === "string") {
          try {
            const next = handleIncoming(data);
            if (next !== data && typeof next === "string") {
              Object.defineProperty(event, "data", {
                configurable: true,
                enumerable: true,
                writable: true,
                value: next,
              });
            }
          } catch (e) {
          }
          return listener.call(this, event);
        }
        // Binary / Blob frames — pass through untouched (video stream, protobuf, etc.)
        return listener.call(this, event);
      };
    }

    function isLiveGameSocketUrl(url) {
      const u = String(url || "");
      // SoftSwiss game socket only. Broadcaster/chat/dga/video must stay pristine.
      if (/broadcaster|videostats|video\.|chat\.|dga\.|stats\.|promo\.|simm\./i.test(u)) {
        return false;
      }
      return /\/game(\?|$)/i.test(u) || /gs\d*\.pragmaticplaylive\.net\/game/i.test(u) || /\/BJ\d[\w.]*-/i.test(u);
    }

    // WebSocket hook — game SoftSwiss only (do not touch broadcaster video WS)
    try {
      const OriginalWebSocket = window.WebSocket;
      if (!OriginalWebSocket.__larpLiveCasinoHooked) {
        const Proxied = new Proxy(OriginalWebSocket, {
          construct(Target, args) {
            const ws = new Target(...args);
            const url = String(args && args[0] || "");
            try {
              LOG("ws open", url.slice(0, 160), isLiveGameSocketUrl(url) ? "(hooked)" : "(passthrough)");
            } catch (e) {
            }
            if (!isLiveGameSocketUrl(url)) {
              return ws;
            }
            const originalSend = ws.send.bind(ws);
            ws.send = function (data) {
              if (typeof data === "string") data = handleOutgoing(data);
              return originalSend(data);
            };
            const originalAddEventListener = ws.addEventListener.bind(ws);
            ws.addEventListener = function (type, listener, options) {
              if (type === "message" && typeof listener === "function") {
                return originalAddEventListener(type, wrapIncomingListener(listener), options);
              }
              return originalAddEventListener(type, listener, options);
            };
            let onmessageHandler = null;
            Object.defineProperty(ws, "onmessage", {
              configurable: true,
              enumerable: true,
              get() {
                return onmessageHandler;
              },
              set(fn) {
                onmessageHandler = typeof fn === "function" ? wrapIncomingListener(fn) : fn;
              },
            });
            return ws;
          },
        });
        Proxied.__larpLiveCasinoHooked = true;
        window.WebSocket = Proxied;
      }
    } catch (e) {
      LOG("ws hook failed", e);
    }

    // fetch / XHR wallet balance spoof
    try {
      const originalFetch = window.fetch.bind(window);
      window.fetch = async function (input, init) {
        const url = String(typeof input === "string" ? input : (input && input.url) || "");
        const response = await originalFetch(input, init);
        if (!/wallet\/balance|\/balance/i.test(url)) return response;
        try {
          const ct = String(response.headers.get("content-type") || "");
          if (!/json|text/i.test(ct)) return response;
          const text = await response.clone().text();
          const rewritten = rewriteWalletBalanceText(text);
          if (rewritten === text) return response;
          return new Response(rewritten, {
            status: response.status,
            statusText: response.statusText,
            headers: response.headers,
          });
        } catch (e) {
          return response;
        }
      };
    } catch (e) {
    }

    try {
      const XHR = window.XMLHttpRequest;
      if (XHR && !XHR.prototype.__larpLiveCasinoHooked) {
        const originalOpen = XHR.prototype.open;
        const originalSend = XHR.prototype.send;
        XHR.prototype.open = function (method, url, ...rest) {
          this.__larpUrl = String(url || "");
          return originalOpen.call(this, method, url, ...rest);
        };
        XHR.prototype.send = function (body) {
          if (/wallet\/balance|\/balance/i.test(this.__larpUrl || "")) {
            this.addEventListener("load", function () {
              try {
                if (this.responseType && this.responseType !== "" && this.responseType !== "text" && this.responseType !== "json") {
                  return;
                }
                const text = this.responseText;
                const rewritten = rewriteWalletBalanceText(text);
                if (rewritten !== text) {
                  Object.defineProperty(this, "responseText", { configurable: true, get: () => rewritten });
                  Object.defineProperty(this, "response", {
                    configurable: true,
                    get: () => {
                      try {
                        return JSON.parse(rewritten);
                      } catch (e) {
                        return rewritten;
                      }
                    },
                  });
                }
              } catch (e) {
              }
            });
          }
          return originalSend.call(this, body);
        };
        XHR.prototype.__larpLiveCasinoHooked = true;
      }
    } catch (e) {
    }

    loadPersisted();
    requestBalanceFromAncestors();
    [500, 1500, 4000].forEach((ms) => setTimeout(requestBalanceFromAncestors, ms));

    // Parent sessionStorage relay poll (cross-subdomain fallback)
    setInterval(() => {
      try {
        loadSharedBetsIntoState();
        const relayBets = sessionStorage.getItem("larp_live_relay_bets");
        if (relayBets) applyBetsPayload(JSON.parse(relayBets), "session-relay");
        const relayResult = sessionStorage.getItem("larp_live_relay_result");
        if (relayResult) {
          const payload = JSON.parse(relayResult);
          if (payload && Date.now() - Number(payload.at || 0) < 15000) {
            handleRelayedResult(payload, "session-relay");
          }
        }
        const last = localStorage.getItem("larp_live_last_result");
        if (last && STATE.roulette_bets.length) {
          const payload = JSON.parse(last);
          if (payload && Date.now() - Number(payload.at || 0) < 20000) {
            handleRelayedResult(payload, "poll-last-result");
          }
        }
      } catch (e) {
      }
    }, 1000);

    // Auto-detect Gates from page title / URL (once SoftSwiss table id also stamps it)
    try {
      if (/gates|olympus|gohroulette|gatesofolympus/i.test(`${document.title} ${location.href}`)) {
        setGates(true);
      }
    } catch (e) {
    }

    window.__larpLiveCasino = {
      state: STATE,
      getBalance,
      setBalance: (v) => setBalance(v),
      setGates,
      trackBet: (betCode, amount) => acceptRouletteBet(betCode, amount, STATE.roulette_table || "", nextSeq(), "manual"),
      forceSettle: (num) => {
        const n = Number(num);
        const color = n === 0 ? "green" : (ROULETTE_RED.has(n) ? "red" : "black");
        return settleRouletteBets(n, color, `manual:${n}:${Date.now()}`, STATE.roulette_table || "");
      },
      calcRoulette,
      calcBac,
      straightMult,
      gates: () => ({
        active: gatesMode(),
        lucky: { ...STATE.gatesLucky },
        bonusNumber: STATE.gatesBonusNumber,
        trackedBets: STATE.roulette_bets.slice(),
        rouletteTable: STATE.roulette_table || "",
        frameId: FRAME_ID,
      }),
    };

    LOG("armed", {
      host: location.hostname,
      balance: getBalance(),
      gates: STATE.gatesOlympus,
      href: String(location.href).slice(0, 120),
    });
  }

  function parseDisplayAmount(text) {
    const cleaned = String(text || "").replace(/[^0-9.,-]/g, "").trim();
    if (!cleaned) {
      return null;
    }

    const normalized = cleaned.includes(",") && cleaned.includes(".")
      ? cleaned.replace(/,/g, "")
      : cleaned.replace(/,/g, "");
    const parsed = Number(normalized);
    return Number.isFinite(parsed) ? parsed : null;
  }

  function formatUsdDisplay(amount) {
    const numericAmount = Number(amount);
    if (!Number.isFinite(numericAmount)) {
      return "";
    }

    try {
      return new Intl.NumberFormat("en-US", {
        style: "currency",
        currency: "USD",
        minimumFractionDigits: 2,
        maximumFractionDigits: 2,
      }).format(Math.max(0, numericAmount));
    } catch (e) {
      return `$${Math.max(0, numericAmount).toFixed(2)}`;
    }
  }

  function formatUsdDisplayText(rawText) {
    const amount = parseDisplayAmount(rawText);
    if (!Number.isFinite(amount)) {
      const sourceText = String(rawText || "").replace(/\s+/g, " ").trim();
      return sourceText.startsWith("$") ? sourceText : "";
    }

    return formatUsdDisplay(amount);
  }

  function setNodeTextValue(targetNode, nextText) {
    if (!(targetNode instanceof Element) || typeof nextText !== "string") {
      return;
    }

    const singleTextChild = targetNode.childNodes.length === 1
      && targetNode.firstChild
      && targetNode.firstChild.nodeType === Node.TEXT_NODE;

    if (singleTextChild) {
      if (targetNode.firstChild.nodeValue !== nextText) {
        targetNode.firstChild.nodeValue = nextText;
      }
    } else if (targetNode.textContent !== nextText) {
      targetNode.textContent = nextText;
    }

    targetNode.setAttribute("data-charcount", String(nextText.length));
  }

  function initExternalSlotBalanceFrame() {
    if (!__isExternalGameHost) {
      return;
    }

    const state = {
      balanceText: "",
      syncedBalanceText: "",
      syncedBalanceValue: null,
      totalBetAmount: 0,
      totalWinAmount: 0,
      lastObservedWinAmount: null,
      waitingForWinChange: false,
      refreshTimer: null,
      visualRefreshTimer: null,
      trackedNodes: new WeakSet(),
      trackedOverrideNodes: new WeakSet(),
      usdFormatLockedNodes: new WeakSet(),
      persistentOverrides: new Map(),
      lastPostedBalanceText: "",
      lastChargeAmount: null,
      lastChargeAt: 0,
    };

    const labelOverrides = [
      { id: "BalanceLabel", text: "BALANCE" },
      { id: "BetAmountLabel", text: "BET" },
      { id: "BetAmountStaticLabel", text: "BET" },
      { id: "WinAmountLabel", text: "WIN" },
    ];

    function forEachRoot(callback) {
      const queue = [document];
      const seen = new Set();

      ShadowRootRegistry.getRoots().forEach((root) => queue.push(root));

      while (queue.length > 0) {
        const root = queue.shift();
        if (!root || seen.has(root)) {
          continue;
        }
        seen.add(root);

        callback(root);

        try {
          if ("querySelectorAll" in root) {
            root.querySelectorAll("*").forEach((element) => {
              if (element?.shadowRoot) {
                queue.push(element.shadowRoot);
              }
            });
            root.querySelectorAll("iframe").forEach((frame) => {
              try {
                if (frame.contentDocument) {
                  queue.push(frame.contentDocument);
                }
              } catch (e) {
              }
            });
          }
        } catch (e) {
        }
      }
    }

    function isManagedBalanceNode(node) {
      return node instanceof Element && String(node.id || "") === "BalanceValue";
    }

    function isLabelOnlyNode(node) {
      if (!(node instanceof Element)) {
        return false;
      }

      const nodeId = String(node.id || "");
      if (/Label$/i.test(nodeId)) {
        return true;
      }

      return Boolean(normalizeDemoLabel(node.textContent || ""));
    }

    function shouldNeverPersistAmount(node) {
      if (!(node instanceof Element)) {
        return false;
      }

      if (isManagedBalanceNode(node) || isLabelOnlyNode(node)) {
        return false;
      }

      const nodeId = String(node.id || "");
      return /Amount|Value|Price|Cost|FeatureBuy|FeatureTotal|WinAmount|BetAmount/i.test(nodeId);
    }

    function clearStaleAmountLocks() {
      for (const [node] of [...state.persistentOverrides.entries()]) {
        if (!(node instanceof Element)) {
          continue;
        }

        if (isManagedBalanceNode(node) || isLabelOnlyNode(node)) {
          continue;
        }

        state.persistentOverrides.delete(node);
      }
    }

    function convertEuroToUsdIfNeeded(node) {
      if (!(node instanceof Element)) {
        return false;
      }

      const text = String(node.textContent || "").replace(/\s+/g, " ").trim();
      if (!text) {
        return false;
      }

      if (!isEuroAmountText(text) && !/^EUR\b/i.test(text)) {
        return false;
      }

      const usdText = toUsdAmountText(text);
      if (!usdText || node.textContent === usdText) {
        return false;
      }

      setNodeTextValue(node, usdText);
      return true;
    }

    function attachUsdFormatLock(node) {
      if (!(node instanceof Element) || isManagedBalanceNode(node) || isLabelOnlyNode(node)) {
        return;
      }

      convertEuroToUsdIfNeeded(node);

      if (state.usdFormatLockedNodes.has(node) || typeof MutationObserver === "undefined") {
        return;
      }

      state.usdFormatLockedNodes.add(node);
      const observer = new MutationObserver(() => {
        convertEuroToUsdIfNeeded(node);
      });
      observer.observe(node, {
        childList: true,
        characterData: true,
        subtree: true,
      });
    }

    function setPersistentText(node, nextText) {
      if (!(node instanceof Element) || typeof nextText !== "string" || !nextText) {
        return;
      }

      if (shouldNeverPersistAmount(node)) {
        setNodeTextValue(node, nextText);
        return;
      }

      state.persistentOverrides.set(node, nextText);
      setNodeTextValue(node, nextText);

      if (state.trackedOverrideNodes.has(node) || typeof MutationObserver === "undefined") {
        return;
      }

      state.trackedOverrideNodes.add(node);
      const observer = new MutationObserver(() => {
        const expected = state.persistentOverrides.get(node);
        if (!expected || shouldNeverPersistAmount(node)) {
          return;
        }

        const current = String(node.textContent || "").replace(/\s+/g, " ").trim();
        if (current !== expected) {
          setNodeTextValue(node, expected);
        }
      });
      observer.observe(node, {
        childList: true,
        characterData: true,
        subtree: true,
      });
    }

    function normalizeDemoLabel(text) {
      const normalized = String(text || "").replace(/\s+/g, " ").trim();
      if (!normalized) {
        return null;
      }

      if (/^demo\s*balance$/i.test(normalized)) {
        return "BALANCE";
      }
      if (/^fun\s*balance$/i.test(normalized)) {
        return "BALANCE";
      }
      if (/^demo$/i.test(normalized)) {
        return "BALANCE";
      }
      if (/^credit$/i.test(normalized)) {
        return "BALANCE";
      }
      if (/demo/i.test(normalized) && /balance/i.test(normalized)) {
        return "BALANCE";
      }

      return null;
    }

    function isEuroAmountText(text) {
      const normalized = String(text || "").replace(/\s+/g, " ").trim();
      if (!normalized || !/(â‚¬|\bEUR\b)/i.test(normalized)) {
        return false;
      }

      return Number.isFinite(parseDisplayAmount(normalized));
    }

    function toUsdAmountText(text) {
      const amount = parseDisplayAmount(text);
      if (!Number.isFinite(amount)) {
        return null;
      }

      return formatUsdDisplay(amount);
    }

    function countEuroChildElements(element) {
      let count = 0;
      if (!(element instanceof Element)) {
        return count;
      }

      element.querySelectorAll("*").forEach((child) => {
        if (!(child instanceof Element) || child === element) {
          return;
        }

        const childText = String(child.textContent || "").replace(/\s+/g, " ").trim();
        if (isEuroAmountText(childText) && child.childElementCount === 0) {
          count += 1;
        }
      });

      return count;
    }

    const usdFormatAmountIds = [
      "BetAmountValue",
      "BetAmountStaticValue",
      "WinAmountValue",
      "FeatureBuyAmountValue",
      "FeatureBuyConfirmValue",
      "FeatureTotalWinValue",
    ];

    function applyUsdFormatLocks() {
      usdFormatAmountIds.forEach((nodeId) => {
        findNodesById(nodeId).forEach((node) => attachUsdFormatLock(node));
      });

      forEachRoot((root) => {
        if (!("querySelectorAll" in root)) {
          return;
        }

        root.querySelectorAll("*").forEach((node) => {
          if (!(node instanceof Element)) {
            return;
          }

          if (isManagedBalanceNode(node) || isLabelOnlyNode(node)) {
            return;
          }

          const text = String(node.textContent || "").replace(/\s+/g, " ").trim();
          if (!isEuroAmountText(text) && !/^EUR\b/i.test(text)) {
            return;
          }

          if (countEuroChildElements(node) > 0) {
            return;
          }

          attachUsdFormatLock(node);
        });
      });
    }

    function applyLabelOverrides() {
      labelOverrides.forEach(({ id, text }) => {
        findNodesById(id).forEach((node) => setPersistentText(node, text));
      });

      forEachRoot((root) => {
        if (!("querySelectorAll" in root)) {
          return;
        }

        root.querySelectorAll("*").forEach((node) => {
          if (!(node instanceof Element)) {
            return;
          }

          const labelText = normalizeDemoLabel(node.textContent || "");
          if (!labelText) {
            return;
          }

          if (node.childElementCount > 0) {
            return;
          }

          setPersistentText(node, labelText);
        });
      });
    }

    function applyCurrencyOverrides() {
      clearStaleAmountLocks();

      findNodesById("BalanceValue").forEach((node) => {
        if (state.balanceText) {
          setPersistentText(node, state.balanceText);
        }
      });

      applyUsdFormatLocks();
    }

    function reapplyPersistentOverrides() {
      clearStaleAmountLocks();

      if (state.balanceText) {
        findNodesById("BalanceValue").forEach((node) => {
          if (node.textContent !== state.balanceText) {
            setNodeTextValue(node, state.balanceText);
          }
        });
      }

      labelOverrides.forEach(({ id, text }) => {
        findNodesById(id).forEach((node) => {
          setPersistentText(node, text);
        });
      });

      forEachRoot((root) => {
        if (!("querySelectorAll" in root)) {
          return;
        }

        root.querySelectorAll("*").forEach((node) => {
          if (!(node instanceof Element)) {
            return;
          }

          const labelText = normalizeDemoLabel(node.textContent || "");
          if (!labelText || node.childElementCount > 0) {
            return;
          }

          setPersistentText(node, labelText);
        });
      });
    }

    function applyVisualOverrides() {
      applyLabelOverrides();
      applyCurrencyOverrides();
      reapplyPersistentOverrides();
    }

    function queueVisualRefresh() {
      if (state.visualRefreshTimer) {
        return;
      }

      state.visualRefreshTimer = setTimeout(() => {
        state.visualRefreshTimer = null;
        applyVisualOverrides();
      }, 0);
    }

    function findNodesBySelector(selector) {
      const nodes = [];
      forEachRoot((root) => {
        if (!("querySelectorAll" in root)) {
          return;
        }

        root.querySelectorAll(selector).forEach((node) => nodes.push(node));
      });
      return [...new Set(nodes)];
    }

    function findNodesById(nodeId) {
      const nodes = [];
      const queue = [document];

      while (queue.length > 0) {
        const root = queue.shift();
        if (!root) {
          continue;
        }

        try {
          if ("getElementById" in root) {
            const directNode = root.getElementById(nodeId);
            if (directNode) {
              nodes.push(directNode);
            }
          }

          if ("querySelectorAll" in root) {
            root.querySelectorAll(`#${nodeId}, [id="${nodeId}"]`).forEach((node) => nodes.push(node));
            root.querySelectorAll("*").forEach((element) => {
              if (element?.shadowRoot) {
                queue.push(element.shadowRoot);
              }
            });
            root.querySelectorAll("iframe").forEach((frame) => {
              try {
                if (frame.contentDocument) {
                  queue.push(frame.contentDocument);
                }
              } catch (e) {
              }
            });
          }
        } catch (e) {
        }
      }

      return [...new Set(nodes)];
    }

    function postToAncestors(balanceText) {
      if (!balanceText) {
        return;
      }

      const payload = {
        [__demoBalanceBridgeKey]: true,
        type: "BALANCE_SYNC",
        balanceText,
      };

      [window.parent, window.top, window.opener].forEach((targetWindow) => {
        if (!targetWindow || targetWindow === window) {
          return;
        }

        try {
          targetWindow.postMessage(payload, "*");
        } catch (e) {
        }
      });
    }

    function requestBalanceFromAncestors() {
      const payload = {
        [__demoBalanceBridgeKey]: true,
        type: "REQUEST_BALANCE",
      };

      [window.parent, window.top, window.opener].forEach((targetWindow) => {
        if (!targetWindow || targetWindow === window) {
          return;
        }

        try {
          targetWindow.postMessage(payload, "*");
        } catch (e) {
        }
      });
    }

    function recalculateDisplayedBalance() {
      const templateText = String(state.syncedBalanceText || state.balanceText || "").trim();
      if (!templateText) {
        return false;
      }

      const syncedValue = Number.isFinite(state.syncedBalanceValue)
        ? state.syncedBalanceValue
        : parseDisplayAmount(templateText);
      if (!Number.isFinite(syncedValue)) {
        state.balanceText = templateText;
        return true;
      }

      const nextValue = Math.max(0, syncedValue - state.totalBetAmount + state.totalWinAmount);
      const nextText = formatUsdDisplay(nextValue) || templateText;
      const changed = state.balanceText !== nextText;
      state.balanceText = nextText;
      return changed;
    }

    function applyBalanceToDom() {
      if (!state.balanceText) {
        return;
      }

      findNodesById("BalanceValue").forEach((node) => {
        setPersistentText(node, state.balanceText);
      });
    }

    function refreshNow() {
      recalculateDisplayedBalance();
      if (!state.balanceText) {
        requestBalanceFromAncestors();
        return;
      }

      applyBalanceToDom();
      applyVisualOverrides();
      if (state.balanceText && state.balanceText !== state.lastPostedBalanceText) {
        state.lastPostedBalanceText = state.balanceText;
        postToAncestors(state.balanceText);
      }
    }

    function refreshSoon(delayMs = 0) {
      if (state.refreshTimer) {
        clearTimeout(state.refreshTimer);
      }

      state.refreshTimer = setTimeout(() => {
        state.refreshTimer = null;
        refreshNow();
      }, Math.max(0, delayMs));
    }

    function getCurrentBetAmount() {
      for (const node of findNodesById("BetAmountValue")) {
        const amount = parseDisplayAmount(node?.textContent || "");
        if (Number.isFinite(amount) && amount > 0) {
          return amount;
        }
      }

      for (const node of findNodesById("BetAmountStaticValue")) {
        const amount = parseDisplayAmount(node?.textContent || "");
        if (Number.isFinite(amount) && amount > 0) {
          return amount;
        }
      }

      return null;
    }

    function getFeatureBuyConfirmAmount() {
      const amountNodeIds = [
        "FeatureBuyConfirmValue",
        "FeatureBuyAmountValue",
      ];
      const amountSelectors = [
        ".FeatureBuyConfirmAmount__value",
        '[class*="FeatureBuyConfirmAmount"]',
        '[class*="FeatureBuyAmount"]',
      ];

      for (const nodeId of amountNodeIds) {
        for (const node of findNodesById(nodeId)) {
          const amount = parseDisplayAmount(node?.textContent || "");
          if (Number.isFinite(amount) && amount > 0) {
            return amount;
          }
        }
      }

      for (const selector of amountSelectors) {
        for (const node of findNodesBySelector(selector)) {
          const amount = parseDisplayAmount(node?.textContent || "");
          if (Number.isFinite(amount) && amount > 0) {
            return amount;
          }
        }
      }

      return null;
    }

    function extractLargestAmountFromElement(element) {
      if (!(element instanceof Element)) {
        return null;
      }

      const matches = String(element.textContent || "").match(/[$â‚¬]\s*[\d,]+(?:\.\d+)?/gi) || [];
      let largestAmount = 0;

      matches.forEach((match) => {
        const amount = parseDisplayAmount(match);
        if (Number.isFinite(amount) && amount > largestAmount) {
          largestAmount = amount;
        }
      });

      return largestAmount > 0 ? largestAmount : null;
    }

    function isFeatureBuyContext(element) {
      if (!(element instanceof Element)) {
        return false;
      }

      return Boolean(element.closest(
        '[class*="FeatureBuy"], [class*="feature-buy"], [class*="FeatureBuyConfirm"], [id*="FeatureBuy"], [class*="BonusBuy"]'
      ));
    }

    function getFeatureBuyConfirmButtonFromTarget(target) {
      if (!(target instanceof Element)) {
        return null;
      }

      try {
        return target.closest(
          '#FeatureBuyConfirmButton, .FeatureBuyConfirmBox__button--accept, [data-feature-buy-confirm], button[data-feature-buy-confirm], button[class*="FeatureBuyConfirm"], [class*="FeatureBuyConfirmBox"] button, [class*="feature-buy-confirm"]'
        );
      } catch (e) {
        return null;
      }
    }

    function getFeatureBuyOptionFromTarget(target) {
      if (!(target instanceof Element)) {
        return null;
      }

      try {
        return target.closest(
          '[class*="FeatureBuyOption"], [class*="featureBuyOption"], [class*="FeatureBuyCard"], [class*="BonusBuyCard"], [class*="feature-buy-option"], [data-feature-buy-option]'
        );
      } catch (e) {
        return null;
      }
    }

    function isFeatureBuyActionButton(element) {
      if (!(element instanceof Element)) {
        return false;
      }

      const label = String(element.textContent || "").replace(/\s+/g, " ").trim().toLowerCase();
      return /^(buy|confirm|accept|purchase|yes|ok)$/.test(label)
        || /buy now|confirm purchase|accept purchase/.test(label);
    }

    function prepareForNextWinAmount() {
      const currentWinAmount = getCurrentWinAmount();
      state.lastObservedWinAmount = Number.isFinite(currentWinAmount) ? currentWinAmount : 0;
      state.waitingForWinChange = true;
    }

    function chargeWager(amount) {
      if (!(amount > 0)) {
        return;
      }

      const now = Date.now();
      if (
        state.lastChargeAmount === amount
        && now - state.lastChargeAt < 2500
      ) {
        return;
      }

      state.lastChargeAmount = amount;
      state.lastChargeAt = now;
      prepareForNextWinAmount();
      setTimeout(() => applyBetDeduction(amount), 0);
    }

    function resolveFeatureBuyPurchaseAmount(target) {
      const confirmAmount = getFeatureBuyConfirmAmount();
      if (Number.isFinite(confirmAmount) && confirmAmount > 0) {
        return confirmAmount;
      }

      const option = getFeatureBuyOptionFromTarget(target);
      if (option instanceof Element) {
        const optionAmount = extractLargestAmountFromElement(option);
        if (Number.isFinite(optionAmount) && optionAmount > 0) {
          return optionAmount;
        }
      }

      const context = isFeatureBuyContext(target)
        ? target.closest('[class*="FeatureBuy"], [class*="FeatureBuyConfirm"], [id*="FeatureBuy"]')
        : null;
      if (context instanceof Element) {
        const contextAmount = extractLargestAmountFromElement(context);
        if (Number.isFinite(contextAmount) && contextAmount > 0) {
          return contextAmount;
        }
      }

      return null;
    }

    function getCurrentWinAmount() {
      for (const node of findNodesById("WinAmountValue")) {
        const amount = parseDisplayAmount(node?.textContent || "");
        if (Number.isFinite(amount) && amount >= 0) {
          return amount;
        }
      }

      return null;
    }

    function applyBetDeduction(betAmount) {
      if (!(betAmount > 0)) {
        return;
      }

      state.totalBetAmount += betAmount;
      refreshNow();
    }

    function applyWinAddition(winAmount) {
      if (!(winAmount > 0)) {
        return;
      }

      state.totalWinAmount += winAmount;
      refreshNow();
    }

    function syncWinAmountState() {
      const currentWinAmount = getCurrentWinAmount();
      if (!Number.isFinite(currentWinAmount)) {
        return;
      }

      if (state.waitingForWinChange) {
        state.lastObservedWinAmount = currentWinAmount;
        state.waitingForWinChange = false;
        return;
      }

      if (!Number.isFinite(state.lastObservedWinAmount)) {
        state.lastObservedWinAmount = currentWinAmount;
        return;
      }

      if (currentWinAmount > state.lastObservedWinAmount) {
        applyWinAddition(currentWinAmount - state.lastObservedWinAmount);
      }

      state.lastObservedWinAmount = currentWinAmount;
    }

    window.addEventListener("message", (event) => {
      const data = event?.data;
      if (!data || data[__demoBalanceBridgeKey] !== true) {
        return;
      }

      if (data.type === "REQUEST_BALANCE") {
        if (state.balanceText) {
          postToAncestors(state.balanceText);
        }
        return;
      }

      if (data.type !== "BALANCE_SYNC") {
        return;
      }

      const nextBalanceText = String(data.balanceText || "").replace(/\s+/g, " ").trim();
      const nextBalanceValue = parseDisplayAmount(nextBalanceText);
      if (!nextBalanceText || !Number.isFinite(nextBalanceValue)) {
        return;
      }

      state.syncedBalanceText = nextBalanceText;
      state.syncedBalanceValue = nextBalanceValue;
      state.totalBetAmount = 0;
      state.totalWinAmount = 0;
      state.lastObservedWinAmount = null;
      state.waitingForWinChange = false;
      recalculateDisplayedBalance();
      refreshSoon(0);
    });

    document.addEventListener("click", (event) => {
      const target = event?.target;
      if (!(target instanceof Element)) {
        return;
      }

      const featureBuyConfirmButton = getFeatureBuyConfirmButtonFromTarget(target);
      if (featureBuyConfirmButton instanceof Element) {
        const purchaseAmount = resolveFeatureBuyPurchaseAmount(target);
        if (purchaseAmount > 0) {
          chargeWager(purchaseAmount);
        }
        return;
      }

      if (isFeatureBuyContext(target)) {
        const actionButton = target.closest('button, [role="button"]');
        if (actionButton instanceof Element && isFeatureBuyActionButton(actionButton)) {
          const purchaseAmount = resolveFeatureBuyPurchaseAmount(target);
          if (purchaseAmount > 0) {
            chargeWager(purchaseAmount);
          }
          return;
        }
      }

      let placeBetButton = null;
      try {
        placeBetButton = target.closest("#PlaceBetButton, .PlaceBetButton, button[id*='PlaceBet'], button[class*='PlaceBet']");
      } catch (e) {
      }

      if (!(placeBetButton instanceof Element)) {
        return;
      }

      const betAmount = getCurrentBetAmount();
      if (betAmount > 0) {
        chargeWager(betAmount);
      }
    }, true);

    if (typeof MutationObserver !== "undefined") {
      const observer = new MutationObserver(() => {
        syncWinAmountState();
        queueVisualRefresh();
        refreshSoon(0);
      });
      observer.observe(document.documentElement, {
        childList: true,
        subtree: true,
        characterData: true,
      });
    }

    requestBalanceFromAncestors();
    setInterval(() => {
      if (!state.balanceText) {
        requestBalanceFromAncestors();
      }
      refreshNow();
      applyVisualOverrides();
    }, 500);
  }

  initExternalSlotBalanceFrame();

  const CONFIG = {
    GRAPHQL_ENDPOINT: "https://shuffle.com/main-api/graphql/api/graphql",
    LARP_SERVER: "http://localhost:5000",
    SHUFFLE_BRIDGE_BASE: "http://127.0.0.1:3847/api/trezor-transfer",
    SHUFFLE_BRIDGE_INBOX_ENDPOINT: "http://127.0.0.1:3847/api/trezor-transfer/inbox",
    SHUFFLE_BRIDGE_HEARTBEAT_ENDPOINT: "http://127.0.0.1:3847/api/trezor-transfer/heartbeat",
    SHUFFLE_BRIDGE_ACK_ENDPOINT: "http://127.0.0.1:3847/api/trezor-transfer/ack",
    SHUFFLE_BRIDGE_SEND_ENDPOINT: "http://127.0.0.1:3847/api/trezor-transfer/send",
    SHUFFLE_EXODUS_BRIDGE_ENDPOINT: "http://127.0.0.1:3847/api/exodus/incoming",
    // When true, Limbo force-wins only if target multiplier is >= FORCE_LIMBO_WIN_MIN.
    // Each guaranteed target wins after a random 1â€“15 attempts (then the streak resets).
    FORCE_LIMBO_WIN: true,
    FORCE_LIMBO_WIN_MIN: 300,
    FORCE_LIMBO_WIN_ATTEMPTS_MIN: 1,
    FORCE_LIMBO_WIN_ATTEMPTS_MAX: 15,
    // Dice: when payout multiplier is >= FORCE_DICE_WIN_MIN, force a win within 5â€“20 attempts.
    FORCE_DICE_WIN: true,
    FORCE_DICE_WIN_MIN: 500,
    FORCE_DICE_WIN_ATTEMPTS_MIN: 5,
    FORCE_DICE_WIN_ATTEMPTS_MAX: 20,
    // Keno fake wins (High risk only):
    // 5 picks â†’ all 5 hit (450x) within 1â€“15 attempts
    // 10 picks â†’ 8/9/10 hits (500x/800x/1000x) randomly within 1â€“15 attempts
    FORCE_KENO_WIN: true,
    FORCE_KENO_WIN_ATTEMPTS_MIN: 1,
    FORCE_KENO_WIN_ATTEMPTS_MAX: 15,
    FORCE_KENO_DRAW_COUNT: 10,
    FORCE_KENO_PAYOUTS: {
      5: { 5: 450 },
      10: { 8: 500, 9: 800, 10: 1000 },
    },
    // Blitz: unique cards >= 23 forces a win within 3â€“25 attempts.
    FORCE_BLITZ_WIN: true,
    FORCE_BLITZ_WIN_MIN_UNIQUE: 23,
    FORCE_BLITZ_WIN_ATTEMPTS_MIN: 3,
    FORCE_BLITZ_WIN_ATTEMPTS_MAX: 25,
    // Sports: auto-settle pending bets as WON after fixture start + delay; cashout available while pending.
    SPORTS_AUTO_WIN: true,
    SPORTS_SETTLE_DELAY_MS: 90000,
    FORCE_BLITZ_PAYOUTS: {
      5: 1.19, 6: 1.32, 7: 1.49, 8: 1.73, 9: 2.04, 10: 2.47,
      11: 3.06, 12: 3.87, 13: 5.04, 14: 6.72, 15: 9.19, 16: 12.92,
      17: 18.66, 18: 27.72, 19: 42.40, 20: 66.81, 21: 108.56, 22: 182.10,
      23: 315.64, 24: 565.98, 25: 1051.10, 26: 2024.34, 27: 4048.68, 28: 8421.26,
      29: 18246.06, 30: 41251.96, 31: 97504.63, 32: 241440.04, 33: 627744.11,
      34: 1718036.50, 35: 4963216.57, 36: 15181603.62,
    },
    // Roulette: force ball to land on a number (0-36). null = random spin.
    ROULETTE_LANDING_NUMBER: null,
    // Blackjack (live casino): force a win every 1-10 hands.
    FORCE_BLACKJACK_WIN: false,
    BLACKJACK_WIN_ATTEMPTS_MIN: 1,
    BLACKJACK_WIN_ATTEMPTS_MAX: 10,
    STORAGE_KEYS: {
      balances: "balances",
      vaultBalances: "vault_balances",
      profile: "profile",
      betHistory: "bet_history",
      notificationHistory: "notification_history",
      depositHistory: "deposit_history",
      withdrawHistory: "withdraw_history",
      tipHistory: "tip_history",
      sportsBetHistory: "sports_bet_history",
      sportsSelectionCache: "sports_selection_cache",
      currencyUsdRates: "currency_usd_rates",
      currencyLogoCache: "currency_logo_cache",
      rakebackBalances: "rakeback_balances",
    },
    // Official Shuffle formula: wager * houseEdge * 5%
    RAKEBACK: {
      HOUSE_EDGE: 0.01,
      SHARE_OF_EDGE: 0.05,
      MIN_VIP: "BRONZE_1",
      // When mocking a rich profile, seed this fraction of lifetime theoretical rakeback as claimable
      RICH_SEED_FRACTION: 0.002,
    },
    PRICE_API_ENDPOINT: "https://api.coingecko.com/api/v3/simple/price",
    PRICE_CACHE_MS: 120000,
    DEFAULT_PROFILE: {
      username: __preferredUsername,
      vipLevel: "UNRANKED",
      xp: 0,
      usdWagered: "0",
      bets: null,
      createdAt: null,
    },
    CURRENCY_TIMINGS: {
      'BTC': { pending: 2000, confirm: 600000 },
      'ETH': { pending: 1000, confirm: 15000 },
      'SOL': { pending: 500, confirm: 2000 },
      'LTC': { pending: 1000, confirm: 150000 },
      'DOGE': { pending: 500, confirm: 60000 },
      'USDT': { pending: 1000, confirm: 15000 },
      'USDC': { pending: 1000, confirm: 15000 },
      'XRP': { pending: 500, confirm: 5000 },
      'ADA': { pending: 1000, confirm: 120000 },
      'MATIC': { pending: 500, confirm: 3000 },
      'BNB': { pending: 500, confirm: 3000 },
      'TRX': { pending: 500, confirm: 3000 },
      'DAI': { pending: 1000, confirm: 15000 },
      'BUSD': { pending: 1000, confirm: 15000 },
      'SHIB': { pending: 1000, confirm: 15000 },
      'SHFL': { pending: 1000, confirm: 15000 },
      'BONK': { pending: 500, confirm: 2000 },
      'WIF': { pending: 500, confirm: 2000 },
      'TON': { pending: 500, confirm: 5000 },
      'AVAX': { pending: 500, confirm: 2000 },
      'TRUMP': { pending: 1000, confirm: 15000 },
      'PUMP': { pending: 500, confirm: 2000 },
      'GC': { pending: 1000, confirm: 30000 },
      'SC': { pending: 1000, confirm: 30000 }
    },
    CURRENCY_TO_CHAIN: {
      'BTC': 'BITCOIN',
      'ETH': 'ETHEREUM',
      'SOL': 'SOLANA',
      'LTC': 'LITECOIN',
      'DOGE': 'DOGECOIN',
      'USDT': 'ETHEREUM',
      'USDC': 'ETHEREUM',
      'XRP': 'RIPPLE',
      'ADA': 'CARDANO',
      'MATIC': 'POLYGON',
      'BNB': 'BINANCE',
      'TRX': 'TRON',
      'DAI': 'ETHEREUM',
      'BUSD': 'BINANCE',
      'SHIB': 'ETHEREUM',
      'SHFL': 'ETHEREUM',
      'BONK': 'SOLANA',
      'WIF': 'SOLANA',
      'TON': 'TON',
      'AVAX': 'AVALANCHE',
      'TRUMP': 'ETHEREUM',
      'PUMP': 'SOLANA',
      'GC': 'UNKNOWN',
      'SC': 'UNKNOWN'
    },
    CURRENCY_TO_COINGECKO_ID: {
      BTC: "bitcoin",
      ETH: "ethereum",
      SOL: "solana",
      LTC: "litecoin",
      DOGE: "dogecoin",
      USDT: "tether",
      USDC: "usd-coin",
      XRP: "ripple",
      ADA: "cardano",
      MATIC: "matic-network",
      BNB: "binancecoin",
      TRX: "tron",
      DAI: "dai",
      BUSD: "binance-usd",
      SHIB: "shiba-inu",
      SHFL: "shuffle",
      BONK: "bonk",
      WIF: "dogwifhat",
      TON: "toncoin",
      AVAX: "avalanche-2",
      TRUMP: "official-trump",
    },
    VIP_LEVELS: [
      { level: "UNRANKED", amount: 0 },
      { level: "WOOD", amount: 500 },
      { level: "BRONZE_1", amount: 1000 },
      { level: "BRONZE_2", amount: 2000 },
      { level: "BRONZE_3", amount: 3000 },
      { level: "BRONZE_4", amount: 4000 },
      { level: "BRONZE_5", amount: 5000 },
      { level: "SILVER_1", amount: 10000 },
      { level: "SILVER_2", amount: 20000 },
      { level: "SILVER_3", amount: 30000 },
      { level: "SILVER_4", amount: 40000 },
      { level: "SILVER_5", amount: 50000 },
      { level: "GOLD_1", amount: 100000 },
      { level: "GOLD_2", amount: 150000 },
      { level: "GOLD_3", amount: 200000 },
      { level: "GOLD_4", amount: 250000 },
      { level: "GOLD_5", amount: 300000 },
      { level: "PLATINUM_1", amount: 450000 },
      { level: "PLATINUM_2", amount: 600000 },
      { level: "PLATINUM_3", amount: 750000 },
      { level: "PLATINUM_4", amount: 900000 },
      { level: "PLATINUM_5", amount: 1050000 },
      { level: "JADE_1", amount: 1200000 },
      { level: "JADE_2", amount: 1350000 },
      { level: "JADE_3", amount: 1500000 },
      { level: "JADE_4", amount: 1650000 },
      { level: "JADE_5", amount: 1800000 },
      { level: "SAPPHIRE_1", amount: 2300000 },
      { level: "SAPPHIRE_2", amount: 2800000 },
      { level: "SAPPHIRE_3", amount: 3300000 },
      { level: "SAPPHIRE_4", amount: 3800000 },
      { level: "SAPPHIRE_5", amount: 4300000 },
      { level: "RUBY_1", amount: 5800000 },
      { level: "RUBY_2", amount: 7300000 },
      { level: "RUBY_3", amount: 8800000 },
      { level: "RUBY_4", amount: 10300000 },
      { level: "RUBY_5", amount: 11800000 },
      { level: "DIAMOND_1", amount: 17000000 },
      { level: "DIAMOND_2", amount: 22000000 },
      { level: "DIAMOND_3", amount: 27000000 },
      { level: "DIAMOND_4", amount: 32000000 },
      { level: "DIAMOND_5", amount: 37000000 },
      { level: "OPAL_1", amount: 90000000 },
      { level: "OPAL_2", amount: 140000000 },
      { level: "OPAL_3", amount: 190000000 },
      { level: "OPAL_4", amount: 240000000 },
      { level: "OPAL_5", amount: 290000000 },
      { level: "DRAGON_1", amount: 340000000 },
      { level: "DRAGON_2", amount: 440000000 },
      { level: "DRAGON_3", amount: 540000000 },
      { level: "DRAGON_4", amount: 640000000 },
      { level: "DRAGON_5", amount: 740000000 },
      { level: "MYTHIC", amount: 1000000000 },
      { level: "DARK", amount: 5000000000 },
      { level: "LEGEND", amount: 10000000000 }
    ]
  };

  // ===== Win-rate settings menu (Ctrl+Shift+L) =====
  {
    const WINRATE_STORE_KEY = "larp_winrate_config_v1";
    const WINRATE_FIELDS = [
      { group: "Limbo", label: "Force wins", type: "bool", cfgKey: "FORCE_LIMBO_WIN" },
      { group: "Limbo", label: "Win every min bets", type: "num", cfgKey: "FORCE_LIMBO_WIN_ATTEMPTS_MIN", min: 1 },
      { group: "Limbo", label: "Win every max bets", type: "num", cfgKey: "FORCE_LIMBO_WIN_ATTEMPTS_MAX", min: 1 },
      { group: "Limbo", label: "Min multiplier (>=)", type: "num", cfgKey: "FORCE_LIMBO_WIN_MIN", min: 1 },
      { group: "Dice", label: "Force wins", type: "bool", cfgKey: "FORCE_DICE_WIN" },
      { group: "Dice", label: "Win every min bets", type: "num", cfgKey: "FORCE_DICE_WIN_ATTEMPTS_MIN", min: 1 },
      { group: "Dice", label: "Win every max bets", type: "num", cfgKey: "FORCE_DICE_WIN_ATTEMPTS_MAX", min: 1 },
      { group: "Dice", label: "Min multiplier (>=)", type: "num", cfgKey: "FORCE_DICE_WIN_MIN", min: 1 },
      { group: "Keno", label: "Force wins", type: "bool", cfgKey: "FORCE_KENO_WIN" },
      { group: "Keno", label: "Win every min bets", type: "num", cfgKey: "FORCE_KENO_WIN_ATTEMPTS_MIN", min: 1 },
      { group: "Keno", label: "Win every max bets", type: "num", cfgKey: "FORCE_KENO_WIN_ATTEMPTS_MAX", min: 1 },
      { group: "Blitz", label: "Force wins", type: "bool", cfgKey: "FORCE_BLITZ_WIN" },
      { group: "Blitz", label: "Win every min bets", type: "num", cfgKey: "FORCE_BLITZ_WIN_ATTEMPTS_MIN", min: 1 },
      { group: "Blitz", label: "Win every max bets", type: "num", cfgKey: "FORCE_BLITZ_WIN_ATTEMPTS_MAX", min: 1 },
      { group: "Blitz", label: "Min unique cards (>=)", type: "num", cfgKey: "FORCE_BLITZ_WIN_MIN_UNIQUE", min: 1 },
      { group: "Sports", label: "Auto-win pending bets", type: "bool", cfgKey: "SPORTS_AUTO_WIN" },
      { group: "Roulette", label: "Force landing number", type: "num", cfgKey: "ROULETTE_LANDING_NUMBER", min: 0, max: 36, step: 1, nullable: true },
      { group: "Blackjack", label: "Force wins", type: "bool", cfgKey: "FORCE_BLACKJACK_WIN" },
      { group: "Blackjack", label: "Win every min hands", type: "num", cfgKey: "BLACKJACK_WIN_ATTEMPTS_MIN", min: 1 },
      { group: "Blackjack", label: "Win every max hands", type: "num", cfgKey: "BLACKJACK_WIN_ATTEMPTS_MAX", min: 1 },
    ];
    const persistWinrate = () => {
      const map = {};
      WINRATE_FIELDS.forEach((f) => { map[f.cfgKey] = CONFIG[f.cfgKey]; });
      try { localStorage.setItem(WINRATE_STORE_KEY, JSON.stringify(map)); } catch (e) {}
    };
    try {
      const saved = JSON.parse(localStorage.getItem(WINRATE_STORE_KEY) || "null");
      if (saved && typeof saved === "object") {
        Object.keys(saved).forEach((k) => {
          if (k in CONFIG) CONFIG[k] = saved[k];
        });
      }
    } catch (e) {}
    let winratePanel = null;
    const toggleWinrateMenu = () => {
      try {
        if (winratePanel && winratePanel.parentNode) {
          document.body.removeChild(winratePanel);
          winratePanel = null;
          return;
        }
        const panel = document.createElement("div");
        winratePanel = panel;
        panel.style.cssText = "position:fixed;top:60px;right:16px;z-index:2147483647;background:#0e0e12;color:#eee;border:1px solid #333;border-radius:8px;padding:14px 16px;font:13px/1.5 monospace;width:330px;max-height:80vh;overflow:auto;box-shadow:0 8px 40px rgba(0,0,0,.7)";
        const title = document.createElement("div");
        title.textContent = "LARP Win-Rate (Ctrl+Shift+L)";
        title.style.cssText = "font-weight:bold;margin-bottom:10px;color:#9cff9c";
        panel.appendChild(title);
        let currentGroup = "";
        WINRATE_FIELDS.forEach((f) => {
          if (f.group !== currentGroup) {
            currentGroup = f.group;
            const g = document.createElement("div");
            g.textContent = "— " + currentGroup + " —";
            g.style.cssText = "margin:10px 0 4px;color:#7fd3ff;border-top:1px solid #2a2a2a;padding-top:6px";
            panel.appendChild(g);
          }
          const row = document.createElement("div");
          row.style.cssText = "display:flex;align-items:center;justify-content:space-between;gap:8px;margin:4px 0";
          const label = document.createElement("span");
          label.textContent = f.label;
          label.style.cssText = "flex:1;color:#ccc";
          let input;
          if (f.type === "bool") {
            input = document.createElement("input");
            input.type = "checkbox";
            input.checked = !!CONFIG[f.cfgKey];
          } else {
            input = document.createElement("input");
            input.type = "number";
            input.value = CONFIG[f.cfgKey] == null ? "" : String(CONFIG[f.cfgKey]);
            if (f.min != null) input.min = String(f.min);
            if (f.max != null) input.max = String(f.max);
            if (f.step) input.step = String(f.step);
            input.style.cssText = "width:70px;background:#222;color:#fff;border:1px solid #444;border-radius:4px;padding:2px 4px;text-align:right";
          }
          input.addEventListener("change", () => {
            if (f.type === "bool") {
              CONFIG[f.cfgKey] = input.checked;
            } else {
              const v = input.value.trim();
              CONFIG[f.cfgKey] = v === "" && f.nullable ? null : Number(v);
            }
            persistWinrate();
          });
          row.appendChild(label);
          row.appendChild(input);
          panel.appendChild(row);
        });
        const hint = document.createElement("div");
        hint.textContent = "Win rate ≈ 100 / average(min,max) bets. Changes save automatically.";
        hint.style.cssText = "margin-top:10px;color:#888;font-size:11px";
        panel.appendChild(hint);
        document.body.appendChild(panel);
      } catch (e) {
        console.error("[LARP] winrate menu error", e);
      }
    };
    window.addEventListener("keydown", (ev) => {
      if (ev.ctrlKey && ev.shiftKey && (ev.key === "L" || ev.key === "l")) {
        ev.preventDefault();
        ev.stopPropagation();
        toggleWinrateMenu();
      }
    });

    // Expose toggle function to console for debugging
    window.toggleWinrateMenu = toggleWinrateMenu;
  }


  const __nativeFetch = window.fetch;
  let __interceptorReady = false;
  let __subscriptionMessageHandler = null;
  let __subscriptionMessageTransform = null;

  const __stubbedFetch = async function (url, ...args) {
    if (__interceptorReady) {
      return Network.__interceptedFetch(__nativeFetch, url, args);
    }
    return __nativeFetch(url, ...args);
  };
  __stubbedFetch.__larpIntercepted = true;
  window.fetch = __stubbedFetch;

  window.WebSocket = new Proxy(window.WebSocket, {
    construct(target, args) {
      const ws = new target(...args);
      const url = args[0];

      if (!url.includes('wss://shuffle.com/main-api/bp-subscription/subscription/graphql')) {
        return ws;
      }

      const subscriptions = new Map();

      const messageListeners = [];
      let onmessageHandler = null;
      let wrappedOnMessageHandler = null;

      const processMessageEvent = (event) => {
        if (typeof __subscriptionMessageHandler === "function") {
          try {
            __subscriptionMessageHandler(event);
          } catch (e) {
          }
        }
      };

      const transformMessageEvent = (event) => {
        if (typeof __subscriptionMessageTransform === "function") {
          try {
            return __subscriptionMessageTransform(event) || event;
          } catch (e) {
          }
        }
        return event;
      };

      const proxy = new Proxy(ws, {
        get(target, prop) {
          const value = target[prop];

          if (prop === 'send') {
            return function(data) {

              try {
                const parsed = JSON.parse(data);

                if (parsed.type === 'subscribe') {
                  const { id, payload } = parsed;
                  const operationName = payload?.operationName;

                  subscriptions.set(operationName, {
                    id: id,
                    operationName: operationName,
                    query: payload?.query,
                    variables: payload?.variables
                  });
                }
              } catch (e) {
              }

              return target.send.call(target, data);
            };
          }

          if (prop === 'addEventListener') {
            return function(type, listener, ...rest) {
              if (type === 'message') {
                const wrappedListener = function(event) {
                  const transformedEvent = transformMessageEvent(event);
                  processMessageEvent(transformedEvent);
                  return listener.call(this, transformedEvent);
                };
                messageListeners.push({ listener: wrappedListener, options: rest });
                return target.addEventListener.call(target, type, wrappedListener, ...rest);
              }
              return target.addEventListener.call(target, type, listener, ...rest);
            };
          }

          if (prop === 'onmessage') {
            return onmessageHandler;
          }

          if (typeof value === 'function') {
            return value.bind(target);
          }

          return value;
        },

        set(target, prop, value) {
          if (prop === 'onmessage') {
            onmessageHandler = value;
            wrappedOnMessageHandler = typeof value === "function"
              ? function(event) {
                  const transformedEvent = transformMessageEvent(event);
                  processMessageEvent(transformedEvent);
                  return value.call(this, transformedEvent);
                }
              : value;
            target[prop] = wrappedOnMessageHandler;
            return true;
          }

          target[prop] = value;
          return true;
        }
      });

      proxy.injectMessage = function(data) {
        const event = new MessageEvent('message', {
          data: typeof data === 'string' ? data : JSON.stringify(data),
          origin: url
        });

        messageListeners.forEach(({ listener }) => {
          try {
            listener.call(proxy, event);
          } catch (e) {
            console.error('Error in message listener:', e);
          }
        });

        if (wrappedOnMessageHandler) {
          try {
            wrappedOnMessageHandler.call(proxy, event);
          } catch (e) {
            console.error('Error in onmessage handler:', e);
          }
        }

      };

      const normalizeOperationName = function(name) {
        return String(name || '')
          .trim()
          .toLowerCase()
          .replace(/[^a-z0-9]/g, '');
      };

      proxy.injectResponse = function(operationName, data) {
        const targetName = String(operationName || '').trim();
        const normalizedTarget = normalizeOperationName(targetName);
        let sub = subscriptions.get(targetName) || subscriptions.get(operationName);

        if (!sub && normalizedTarget) {
          for (const [key, value] of subscriptions.entries()) {
            if (normalizeOperationName(key) === normalizedTarget) {
              sub = value;
              break;
            }
          }
        }

        if (!sub && subscriptions.size === 1) {
          sub = subscriptions.values().next().value;
        }

        if (!sub) {
          return;
        }

        const response = {
          id: sub.id,
          type: 'next',
          payload: {
            data: data
          }
        };

        proxy.injectMessage(JSON.stringify(response));
      };

      proxy.listSubscriptions = function() {
        return Array.from(subscriptions.entries());
      };

      window.targetWs = proxy;
      window.subs = subscriptions;

      DepositSimulator.setGraphQLWebSocket(proxy);

      return proxy;
    }
  });

  const State = {
    currentGame: {},
    currentGameInfo: null,
    currentGameId: null,
    currentBetInfoRequest: null,
    currentCrashBet: null,
    currentCrashState: null,
    limboForceStreaks: {},
    limboForceLast: null,
    kenoForceStreaks: {},
    kenoForceLast: null,
    diceForceStreaks: {},
    diceForceLast: null,
    blitzForceStreaks: {},
    blitzForceLast: null,
    coinflipProgressiveRound: null,
    rouletteLandingNumber: null,
    resolvedCrashBetIds: [],
    resolvedCrashPayouts: {},
    delayedBalanceUpdateTimers: {},
    balances: [],
    vaultBalances: [],
    rakebackBalances: [],
    profile: {},
    totalWagered: 0,
    betHistory: [],
    notificationHistory: [],
    depositHistory: [],
    withdrawHistory: [],
    tipHistory: [],
    sportsBetHistory: [],
    sportsSettlementTimers: {},
    sportsCashoutRefreshTimer: null,
    sportsSelectionCache: {},
    currencyUsdRates: {},
    currencyLogoCache: {},
    _pendingRealWithdraw: null,
    withdrawConfirmationTimers: {},
    userId: null,
    accountId: null,

    init() {
      this.balances = Storage.load(CONFIG.STORAGE_KEYS.balances, []);
      this.vaultBalances = Storage.load(CONFIG.STORAGE_KEYS.vaultBalances, []);
      this.rakebackBalances = Storage.load(CONFIG.STORAGE_KEYS.rakebackBalances, []);
      this.profile = Storage.load(CONFIG.STORAGE_KEYS.profile, CONFIG.DEFAULT_PROFILE);
      if (!this.profile || typeof this.profile !== "object") {
        this.profile = { ...CONFIG.DEFAULT_PROFILE };
      }
      if (!this.profile.username || this.profile.username === "x") {
        this.profile.username = __preferredUsername;
        Storage.save(CONFIG.STORAGE_KEYS.profile, this.profile);
      }
      this.totalWagered = Number(this.profile.usdWagered) || 0;
      this.betHistory = Storage.load(CONFIG.STORAGE_KEYS.betHistory, []);
      this.notificationHistory = Storage.load(CONFIG.STORAGE_KEYS.notificationHistory, []);
      this.depositHistory = Storage.load(CONFIG.STORAGE_KEYS.depositHistory, []);
      this.withdrawHistory = Storage.load(CONFIG.STORAGE_KEYS.withdrawHistory, []);
      this.tipHistory = Storage.load(CONFIG.STORAGE_KEYS.tipHistory, []);
      this.sportsBetHistory = Storage.load(CONFIG.STORAGE_KEYS.sportsBetHistory, []);
      this.sportsSelectionCache = Storage.load(CONFIG.STORAGE_KEYS.sportsSelectionCache, {});
      this.currencyUsdRates = Storage.load(CONFIG.STORAGE_KEYS.currencyUsdRates, {});
      this.currencyLogoCache = Storage.load(CONFIG.STORAGE_KEYS.currencyLogoCache, {});
    }
  };

  const Storage = {
    load(key, fallback) {
      try {
        const raw = localStorage.getItem(key);
        return raw ? JSON.parse(raw) : fallback;
      } catch {
        return fallback;
      }
    },

    save(key, value) {
      localStorage.setItem(key, JSON.stringify(value));
    }
  };

  function randomFromCharset(length, chars) {
    let value = "";
    for (let i = 0; i < length; i++) {
      value += chars.charAt(Math.floor(Math.random() * chars.length));
    }
    return value;
  }

  function generateTxHash(length = 64) {
    return randomFromCharset(length, "0123456789abcdef");
  }

  const CurrencyUsdRates = {
    refreshPromise: null,
    refreshKey: "",

    getCoingeckoId(currency) {
      return CONFIG.CURRENCY_TO_COINGECKO_ID[String(currency || "").toUpperCase()] || null;
    },

    getQuote(currency) {
      const normalizedCurrency = String(currency || "").toUpperCase();
      if (!normalizedCurrency) {
        return null;
      }

      if (["USD", "USDT", "USDC", "BUSD", "DAI", "SC"].includes(normalizedCurrency)) {
        return {
          usd: 1,
          fetchedAt: Date.now(),
          source: "fixed",
        };
      }

      return State.currencyUsdRates?.[normalizedCurrency] || null;
    },

    getUsdRate(currency) {
      const quote = this.getQuote(currency);
      const usd = Number(quote?.usd);
      return Number.isFinite(usd) && usd > 0 ? usd : null;
    },

    getUsdAmount(currency, amount, fallbackUsdAmount = null) {
      const normalizedCurrency = String(currency || "").toUpperCase();
      const numericAmount = Number(amount);
      if (!Number.isFinite(numericAmount) || numericAmount <= 0) {
        return null;
      }

      if (normalizedCurrency === "USD") {
        return numericAmount;
      }

      const liveRate = this.getUsdRate(normalizedCurrency);
      if (Number.isFinite(liveRate) && liveRate > 0) {
        return numericAmount * liveRate;
      }

      if (this.getCoingeckoId(normalizedCurrency)) {
        return null;
      }

      const numericFallback = Number(fallbackUsdAmount);
      if (Number.isFinite(numericFallback) && numericFallback > 0) {
        return numericFallback;
      }

      return null;
    },

    needsRefresh(currency) {
      const normalizedCurrency = String(currency || "").toUpperCase();
      if (!normalizedCurrency || ["USD", "USDT", "USDC", "BUSD", "DAI", "SC", "GC"].includes(normalizedCurrency)) {
        return false;
      }

      const quote = State.currencyUsdRates?.[normalizedCurrency];
      const fetchedAt = Number(quote?.fetchedAt || 0);
      if (!Number.isFinite(fetchedAt) || fetchedAt <= 0) {
        return true;
      }

      return Date.now() - fetchedAt >= CONFIG.PRICE_CACHE_MS;
    },

    async refreshForCurrencies(currencies, options = {}) {
      const normalizedCurrencies = [...new Set(
        (Array.isArray(currencies) ? currencies : [])
          .map((currency) => String(currency || "").toUpperCase())
          .filter(Boolean)
      )];

      const force = !!options.force;
      const currenciesToFetch = normalizedCurrencies.filter((currency) => {
        if (["USD", "USDT", "USDC", "BUSD", "DAI", "SC", "GC"].includes(currency)) {
          return false;
        }
        return force || this.needsRefresh(currency);
      });

      if (currenciesToFetch.length === 0) {
        return State.currencyUsdRates;
      }

      const ids = [...new Set(
        currenciesToFetch
          .map((currency) => this.getCoingeckoId(currency))
          .filter(Boolean)
      )];

      if (ids.length === 0) {
        return State.currencyUsdRates;
      }

      const refreshKey = ids.slice().sort().join(",");
      if (this.refreshPromise && this.refreshKey === refreshKey) {
        return this.refreshPromise;
      }

      const url = `${CONFIG.PRICE_API_ENDPOINT}?${new URLSearchParams({
        ids: ids.join(","),
        vs_currencies: "usd",
        include_last_updated_at: "true",
        precision: "full",
      }).toString()}`;

      this.refreshKey = refreshKey;
      this.refreshPromise = (async () => {
        try {
          const response = await __nativeFetch(url, {
            method: "GET",
            headers: {
              accept: "application/json",
            },
          });

          if (!response?.ok) {
            return State.currencyUsdRates;
          }

          const payload = await response.json();
          const nextRates = { ...(State.currencyUsdRates || {}) };
          const now = Date.now();

          currenciesToFetch.forEach((currency) => {
            const id = this.getCoingeckoId(currency);
            const priceData = id ? payload?.[id] : null;
            const usd = Number(priceData?.usd);
            if (!Number.isFinite(usd) || usd <= 0) {
              return;
            }

            const lastUpdatedAtUnix = Number(priceData?.last_updated_at || 0);
            nextRates[currency] = {
              usd,
              fetchedAt: now,
              source: "coingecko",
              lastUpdatedAt: Number.isFinite(lastUpdatedAtUnix) && lastUpdatedAtUnix > 0
                ? lastUpdatedAtUnix * 1000
                : now,
            };
          });

          State.currencyUsdRates = nextRates;
          Storage.save(CONFIG.STORAGE_KEYS.currencyUsdRates, State.currencyUsdRates);
          WithdrawHistory.refreshUsdAmounts(normalizedCurrencies);
          TransactionIdUI.refreshSoon(0);
          return State.currencyUsdRates;
        } catch (e) {
          return State.currencyUsdRates;
        } finally {
          this.refreshPromise = null;
          this.refreshKey = "";
        }
      })();

      return this.refreshPromise;
    }
  };

  function getValidTransactionId(...candidates) {
    for (const candidate of candidates) {
      if (candidate === undefined || candidate === null) continue;
      const value = String(candidate).trim();
      if (!value) continue;

      const normalizedValue = value.toUpperCase();
      if (
        normalizedValue === "N/A" ||
        normalizedValue === "NA" ||
        normalizedValue === "NONE" ||
        normalizedValue === "NULL" ||
        normalizedValue === "UNDEFINED"
      ) {
        continue;
      }

      return value;
    }

    return null;
  }

  const TxIdGenerator = {
    BASE58: "123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz",
    HEX_LOWER: "0123456789abcdef",
    HEX_UPPER: "0123456789ABCDEF",
    BASE64_URL: "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_",

    generate(currency, chain) {
      const normalizedCurrency = String(currency || "").toUpperCase();
      const normalizedChain = String(
        chain || CONFIG.CURRENCY_TO_CHAIN[normalizedCurrency] || "UNKNOWN"
      ).toUpperCase();

      if (["SOL", "BONK", "WIF", "PUMP"].includes(normalizedCurrency) || normalizedChain === "SOLANA") {
        return randomFromCharset(88, this.BASE58);
      }

      if (normalizedChain === "ETHEREUM" || normalizedChain === "POLYGON" || normalizedChain === "BINANCE" || normalizedChain === "AVALANCHE") {
        return `0x${randomFromCharset(64, this.HEX_LOWER)}`;
      }

      if (normalizedChain === "BITCOIN" || normalizedChain === "LITECOIN" || normalizedChain === "DOGECOIN" || normalizedChain === "CARDANO") {
        return randomFromCharset(64, this.HEX_LOWER);
      }

      if (normalizedChain === "RIPPLE" || normalizedChain === "TRON") {
        return randomFromCharset(64, this.HEX_UPPER);
      }

      if (normalizedChain === "TON") {
        return randomFromCharset(44, this.BASE64_URL);
      }

      return randomFromCharset(44, this.BASE58);
    }
  };

  const BetHistory = {
    generateId() {
      const chars = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';
      let id = '';
      for (let i = 0; i < 21; i++) {
        id += chars.charAt(Math.floor(Math.random() * chars.length));
      }
      return id;
    },

    getCurrentGameInfo() {
      if (State.currentGameInfo) {
        return State.currentGameInfo;
      }

      try {
        const nextDataScript = document.getElementById('__NEXT_DATA__');
        if (nextDataScript) {
          const data = JSON.parse(nextDataScript.textContent);
          const gameData = data?.props?.pageProps?.gameData?.game;

          if (gameData) {
            return {
              id: gameData.id,
              name: gameData.name,
              slug: gameData.slug,
              categories: gameData.gameAndGameCategories || []
            };
          }
        }
      } catch (e) {
      }

      const pathname = window.location?.pathname || "";
      const originalsMatch = pathname.match(/\/games\/originals\/([^/?#]+)/i);
      if (originalsMatch) {
        const slug = originalsMatch[1].toLowerCase();
        const originalNames = {
          baccarat: "Baccarat",
          blackjack: "Blackjack",
          blitz: "Blitz",
          chicken: "Chicken",
          crash: "Crash",
          dice: "Dice",
          hilo: "Hilo",
          keno: "Keno",
          limbo: "Limbo",
          mines: "Mines",
          plinko: "Plinko",
          roulette: "Roulette",
          tower: "Waifu Tower",
          wheel: "Wheel"
        };

        return {
          id: `originals-${slug}`,
          name: originalNames[slug] || slug.charAt(0).toUpperCase() + slug.slice(1),
          slug: `originals/${slug}`,
          categories: [],
        };
      }

      return null;
    },

    addBet(betData) {
      const timestamp = new Date().toISOString();
      const existingBet = State.betHistory.find(b => b.id === (betData.id || ''));

      const bet = {
        id: betData.id || this.generateId(),
        currency: betData.currency || 'BTC',
        amount: String(betData.amount || '0'),
        payout: String(betData.payout || '0'),
        multiplier: Number(betData.multiplier || 0),
        resultMultiplier: betData.resultMultiplier != null
          ? Number(betData.resultMultiplier)
          : existingBet?.resultMultiplier,
        kenoDrawnNumbers: Array.isArray(betData.kenoDrawnNumbers)
          ? betData.kenoDrawnNumbers
          : existingBet?.kenoDrawnNumbers,
        kenoSelectedNumbers: Array.isArray(betData.kenoSelectedNumbers)
          ? betData.kenoSelectedNumbers
          : existingBet?.kenoSelectedNumbers,
        hitCount: betData.hitCount != null ? Number(betData.hitCount) : existingBet?.hitCount,
        diceResultValue: betData.diceResultValue != null
          ? Number(betData.diceResultValue)
          : existingBet?.diceResultValue,
        diceUserValue: betData.diceUserValue != null
          ? Number(betData.diceUserValue)
          : existingBet?.diceUserValue,
        diceDirection: betData.diceDirection || existingBet?.diceDirection,
        blitzCards: Array.isArray(betData.blitzCards) ? betData.blitzCards : existingBet?.blitzCards,
        blitzUniqueCards: betData.blitzUniqueCards != null
          ? Number(betData.blitzUniqueCards)
          : existingBet?.blitzUniqueCards,
        game: betData.game || {
          id: 'unknown',
          name: 'Unknown',
          gameAndGameCategories: [],
          slug: 'unknown',
          __typename: 'Game'
        },
        __typename: 'Bet',
        updatedAt: timestamp,
        createdAt: existingBet?.createdAt || timestamp
      };

      const existingIndex = State.betHistory.findIndex(b => b.id === bet.id);
      if (existingIndex >= 0) {
        State.betHistory.splice(existingIndex, 1);
      }
      State.betHistory.unshift(bet);

      if (State.betHistory.length > 100) {
        State.betHistory = State.betHistory.slice(0, 100);
      }

      Storage.save(CONFIG.STORAGE_KEYS.betHistory, State.betHistory);
    },

    removeBet(id) {
      if (!id) return;

      const existingIndex = State.betHistory.findIndex(b => b.id === id);
      if (existingIndex === -1) return;

      State.betHistory.splice(existingIndex, 1);
      Storage.save(CONFIG.STORAGE_KEYS.betHistory, State.betHistory);
    },

    rekeyBet(oldId, newId) {
      if (!oldId || !newId || oldId === newId) return;

      const existingIndex = State.betHistory.findIndex(b => b.id === oldId);
      if (existingIndex === -1) return;

      const duplicateIndex = State.betHistory.findIndex(b => b.id === newId);
      if (duplicateIndex >= 0 && duplicateIndex !== existingIndex) {
        State.betHistory.splice(duplicateIndex, 1);
      }

      State.betHistory[existingIndex] = {
        ...State.betHistory[existingIndex],
        id: newId,
        updatedAt: new Date().toISOString(),
      };

      Storage.save(CONFIG.STORAGE_KEYS.betHistory, State.betHistory);
    },

    getBets(first = 10, cursor = null, currencyFilter = null) {
      let bets = State.betHistory;

      if (currencyFilter && Array.isArray(currencyFilter) && currencyFilter.length > 0) {
        bets = bets.filter(bet => currencyFilter.includes(bet.currency));
      }

      let startIndex = 0;
      if (cursor) {
        const cursorDate = new Date(cursor);
        startIndex = bets.findIndex(bet => new Date(bet.createdAt) < cursorDate);
        if (startIndex === -1) {
          startIndex = bets.length;
        }
      }

      const nodes = bets.slice(startIndex, startIndex + first);

      let nextCursor = null;
      if (nodes.length > 0 && startIndex + first < bets.length) {
        nextCursor = nodes[nodes.length - 1].createdAt;
      }

      return {
        nodes,
        nextCursor,
        __typename: 'PaginatedBet'
      };
    },

    clear() {
      State.betHistory = [];
      Storage.save(CONFIG.STORAGE_KEYS.betHistory, []);
    }
  };

  const NotificationHistory = {
    addNotification(notificationData) {
      const notification = {
        id: notificationData.id,
        accountId: notificationData.accountId,
        type: notificationData.type,
        readAt: notificationData.readAt || null,
        createdAt: notificationData.createdAt,
        updatedAt: notificationData.updatedAt || notificationData.createdAt,
        seenAt: notificationData.seenAt || null,
        metadata: notificationData.metadata,
        __typename: "UserNotification"
      };

      State.notificationHistory.unshift(notification);

      if (State.notificationHistory.length > 10) {
        State.notificationHistory = State.notificationHistory.slice(0, 10);
      }

      Storage.save(CONFIG.STORAGE_KEYS.notificationHistory, State.notificationHistory);
    },

    getNotifications(first = 25, cursor = null) {
      let notifications = State.notificationHistory;

      let startIndex = 0;
      if (cursor) {
        const cursorDate = new Date(cursor);
        startIndex = notifications.findIndex(n => new Date(n.createdAt) < cursorDate);
        if (startIndex === -1) {
          startIndex = notifications.length;
        }
      }

      const nodes = notifications.slice(startIndex, startIndex + first);

      let nextCursor = null;
      if (nodes.length > 0 && startIndex + first < notifications.length) {
        nextCursor = nodes[nodes.length - 1].createdAt;
      }

      return {
        totalCount: notifications.length,
        nodes,
        nextCursor,
        __typename: 'PaginatedUserNotifications'
      };
    },

    clear() {
      State.notificationHistory = [];
      Storage.save(CONFIG.STORAGE_KEYS.notificationHistory, []);
    }
  };

  const DepositHistory = {
    generateTxHash(currency, chain) {
      return TxIdGenerator.generate(currency, chain);
    },

    normalizeDeposit(depositData) {
      const tx = getValidTransactionId(
        depositData.onChainTransactionId,
        depositData.transactionId,
        depositData.txId,
        depositData.txHash,
        depositData.hash,
        depositData.transactionHash
      ) || this.generateTxHash(depositData.currency, depositData.chain);
      return {
        ...depositData,
        onChainTransactionId: tx,
        transactionId: getValidTransactionId(depositData.transactionId, tx) || tx,
        txId: getValidTransactionId(depositData.txId, tx) || tx,
        txHash: tx,
        hash: tx,
        transactionHash: tx,
      };
    },

    reconcileStoredTxIds() {
      let didUpdate = false;
      State.depositHistory = State.depositHistory.map(deposit => {
        const normalizedDeposit = this.normalizeDeposit(deposit);
        if (
          normalizedDeposit.onChainTransactionId !== deposit.onChainTransactionId ||
          normalizedDeposit.transactionId !== deposit.transactionId ||
          normalizedDeposit.txId !== deposit.txId ||
          normalizedDeposit.txHash !== deposit.txHash ||
          normalizedDeposit.hash !== deposit.hash ||
          normalizedDeposit.transactionHash !== deposit.transactionHash
        ) {
          didUpdate = true;
        }
        return normalizedDeposit;
      });

      if (didUpdate) {
        Storage.save(CONFIG.STORAGE_KEYS.depositHistory, State.depositHistory);
      }
    },

    addDeposit(depositData) {
      const normalizedDeposit = this.normalizeDeposit(depositData);
      const deposit = {
        id: depositData.id,
        userId: depositData.userId,
        onChainTransactionId: normalizedDeposit.onChainTransactionId,
        transactionId: normalizedDeposit.transactionId,
        txId: normalizedDeposit.txId,
        txHash: normalizedDeposit.txHash,
        hash: normalizedDeposit.hash,
        transactionHash: normalizedDeposit.transactionHash,
        chain: depositData.chain,
        currency: depositData.currency,
        amount: String(depositData.amount),
        createdAt: depositData.createdAt,
        status: depositData.status || 'CONFIRMED',
        __typename: 'Deposit'
      };

      State.depositHistory.unshift(deposit);

      Storage.save(CONFIG.STORAGE_KEYS.depositHistory, State.depositHistory);
    },

    getDeposits(first = 10, cursor = null, currencyFilter = null) {
      this.reconcileStoredTxIds();

      let deposits = State.depositHistory;

      if (currencyFilter && Array.isArray(currencyFilter) && currencyFilter.length > 0) {
        deposits = deposits.filter(d => currencyFilter.includes(d.currency));
      }

      let startIndex = 0;
      if (cursor) {
        const cursorDate = new Date(cursor);
        startIndex = deposits.findIndex(d => new Date(d.createdAt) < cursorDate);
        if (startIndex === -1) {
          startIndex = deposits.length;
        }
      }

      const nodes = deposits.slice(startIndex, startIndex + first);

      let nextCursor = null;
      if (nodes.length > 0 && startIndex + first < deposits.length) {
        nextCursor = nodes[nodes.length - 1].createdAt;
      }

      return {
        nodes,
        totalCount: deposits.length,
        nextCursor,
        __typename: 'PaginatedDeposit'
      };
    },

    clear() {
      State.depositHistory = [];
      Storage.save(CONFIG.STORAGE_KEYS.depositHistory, []);
    }
  };

  const WithdrawHistory = {
    getConfirmationDelayMs() {
      return 45000 + Math.floor(Math.random() * 15001);
    },

    normalizeWithdraw(withdrawData) {
      const normalizedCurrency = String(withdrawData.currency || "").toUpperCase();
      const normalizedAmount = String(withdrawData.amount ?? withdrawData.usdAmount ?? "0");
      const normalizedUsdAmount = String(
        CurrencyUsdRates.getUsdAmount(
          normalizedCurrency,
          normalizedAmount,
          withdrawData.usdAmount
        ) ?? withdrawData.usdAmount ?? "0"
      );
      const normalizedStatus = withdrawData.status || "CONFIRMED";
      const tx = getValidTransactionId(
        withdrawData.onChainTransactionId,
        withdrawData.transactionId,
        withdrawData.txId,
        withdrawData.txHash,
        withdrawData.hash,
        withdrawData.transactionHash
      ) || TxIdGenerator.generate(withdrawData.currency, withdrawData.chain);
      return {
        ...withdrawData,
        currency: normalizedCurrency,
        amount: normalizedAmount,
        usdAmount: normalizedUsdAmount,
        status: normalizedStatus,
        onChainTransactionId: tx,
        transactionId: getValidTransactionId(withdrawData.transactionId, tx) || tx,
        txId: getValidTransactionId(withdrawData.txId, tx) || tx,
        txHash: tx,
        hash: tx,
        transactionHash: tx,
      };
    },

    reconcileStoredTxIds() {
      let didUpdate = false;
      State.withdrawHistory = State.withdrawHistory.map(withdraw => {
        const normalizedWithdraw = this.normalizeWithdraw(withdraw);
        if (
          normalizedWithdraw.onChainTransactionId !== withdraw.onChainTransactionId ||
          normalizedWithdraw.transactionId !== withdraw.transactionId ||
          normalizedWithdraw.txId !== withdraw.txId ||
          normalizedWithdraw.txHash !== withdraw.txHash ||
          normalizedWithdraw.hash !== withdraw.hash ||
          normalizedWithdraw.transactionHash !== withdraw.transactionHash ||
          normalizedWithdraw.currency !== withdraw.currency ||
          normalizedWithdraw.amount !== withdraw.amount ||
          normalizedWithdraw.usdAmount !== withdraw.usdAmount ||
          normalizedWithdraw.status !== withdraw.status
        ) {
          didUpdate = true;
        }
        return normalizedWithdraw;
      });

      if (didUpdate) {
        Storage.save(CONFIG.STORAGE_KEYS.withdrawHistory, State.withdrawHistory);
      }
    },

    refreshUsdAmounts(currencies = null) {
      const targetCurrencies = Array.isArray(currencies)
        ? new Set(currencies.map((currency) => String(currency || "").toUpperCase()).filter(Boolean))
        : null;
      let didUpdate = false;

      State.withdrawHistory = State.withdrawHistory.map((withdraw) => {
        if (!withdraw) {
          return withdraw;
        }

        const normalizedCurrency = String(withdraw.currency || "").toUpperCase();
        if (targetCurrencies && !targetCurrencies.has(normalizedCurrency)) {
          return withdraw;
        }

        const convertedUsdAmount = CurrencyUsdRates.getUsdAmount(
          normalizedCurrency,
          withdraw.amount,
          withdraw.usdAmount
        );

        if (!Number.isFinite(convertedUsdAmount) || convertedUsdAmount <= 0) {
          return withdraw;
        }

        const nextUsdAmount = String(convertedUsdAmount);
        if (nextUsdAmount === String(withdraw.usdAmount ?? "")) {
          return withdraw;
        }

        didUpdate = true;
        return {
          ...withdraw,
          usdAmount: nextUsdAmount,
        };
      });

      if (didUpdate) {
        Storage.save(CONFIG.STORAGE_KEYS.withdrawHistory, State.withdrawHistory);
      }
    },

    addWithdraw(withdrawData) {
      const normalizedWithdraw = this.normalizeWithdraw(withdrawData);
      const withdraw = {
        id: withdrawData.id || BetHistory.generateId(),
        userId: withdrawData.userId || "local",
        onChainTransactionId: normalizedWithdraw.onChainTransactionId,
        transactionId: normalizedWithdraw.transactionId,
        txId: normalizedWithdraw.txId,
        txHash: normalizedWithdraw.txHash,
        hash: normalizedWithdraw.hash,
        transactionHash: normalizedWithdraw.transactionHash,
        chain: withdrawData.chain || CONFIG.CURRENCY_TO_CHAIN[normalizedWithdraw.currency] || "UNKNOWN",
        currency: normalizedWithdraw.currency,
        amount: normalizedWithdraw.amount,
        usdAmount: normalizedWithdraw.usdAmount,
        address: withdrawData.address || "0x1LARPxxxxxxxxxxxxxxxxxxxxx",
        createdAt: withdrawData.createdAt || new Date().toISOString(),
        updatedAt: withdrawData.updatedAt || withdrawData.createdAt || new Date().toISOString(),
        confirmAt: withdrawData.confirmAt || null,
        status: normalizedWithdraw.status,
        type: "WITHDRAWAL",
        __typename: "Withdrawal"
      };

      State.withdrawHistory.unshift(withdraw);
      Storage.save(CONFIG.STORAGE_KEYS.withdrawHistory, State.withdrawHistory);
      CurrencyUsdRates.refreshForCurrencies([normalizedWithdraw.currency]);
      return withdraw;
    },

    updateWithdraw(id, updates = {}) {
      if (!id) return null;

      const index = State.withdrawHistory.findIndex(w => w.id === id);
      if (index === -1) return null;

      State.withdrawHistory[index] = {
        ...this.normalizeWithdraw(State.withdrawHistory[index]),
        ...updates,
        updatedAt: updates.updatedAt || new Date().toISOString(),
      };

      State.withdrawHistory[index] = this.normalizeWithdraw(State.withdrawHistory[index]);

      Storage.save(CONFIG.STORAGE_KEYS.withdrawHistory, State.withdrawHistory);
      return State.withdrawHistory[index];
    },

    scheduleConfirmation(withdrawId, delayMs = 30000) {
      if (!withdrawId) return;

      if (State.withdrawConfirmationTimers[withdrawId]) {
        clearTimeout(State.withdrawConfirmationTimers[withdrawId]);
        delete State.withdrawConfirmationTimers[withdrawId];
      }

      State.withdrawConfirmationTimers[withdrawId] = setTimeout(() => {
        delete State.withdrawConfirmationTimers[withdrawId];
        this.confirmWithdraw(withdrawId);
      }, Math.max(0, delayMs));
    },

    confirmWithdraw(withdrawId) {
      const pending = State.withdrawHistory.find(withdraw => withdraw?.id === withdrawId);
      if (!pending || pending.status !== "PENDING") {
        return pending || null;
      }

      const withdraw = this.updateWithdraw(withdrawId, {
        status: "CONFIRMED",
        confirmAt: null,
      });
      if (!withdraw) return null;

      ShuffleBridge.sendWithdrawal(withdraw);

      if (window.targetWs && State.accountId) {
        const timestamp = new Date().toISOString();
        const notification = {
          id: BetHistory.generateId(),
          accountId: State.accountId,
          type: "WITHDRAWAL_COMPLETED",
          readAt: null,
          createdAt: timestamp,
          updatedAt: timestamp,
          seenAt: null,
          metadata: {
            amount: String(withdraw.amount),
            currency: withdraw.currency,
            __typename: "WithdrawalMetadataDto"
          },
          __typename: "UserNotification"
        };

        NotificationHistory.addNotification(notification);
        window.targetWs.injectResponse("NewNotification", {
          notificationCreated: notification
        });
      }

      return withdraw;
    },

    reconcilePendingWithdrawals() {
      const now = Date.now();
      for (const withdraw of State.withdrawHistory) {
        if (!withdraw || withdraw.status !== "PENDING" || !withdraw.confirmAt) {
          continue;
        }

        const confirmAtMs = new Date(withdraw.confirmAt).getTime();
        if (!Number.isFinite(confirmAtMs)) {
          this.confirmWithdraw(withdraw.id);
          continue;
        }

        const remainingMs = confirmAtMs - now;
        if (remainingMs <= 0) {
          this.confirmWithdraw(withdraw.id);
          continue;
        }

        this.scheduleConfirmation(withdraw.id, remainingMs);
      }
    },

    getWithdrawals(first = 10, cursor = null, currencyFilter = null) {
      this.reconcileStoredTxIds();

      let withdrawals = State.withdrawHistory;

      if (currencyFilter && Array.isArray(currencyFilter) && currencyFilter.length > 0) {
        withdrawals = withdrawals.filter(w => currencyFilter.includes(w.currency));
      }

      let startIndex = 0;
      if (cursor) {
        const cursorDate = new Date(cursor);
        startIndex = withdrawals.findIndex(w => new Date(w.createdAt) < cursorDate);
        if (startIndex === -1) {
          startIndex = withdrawals.length;
        }
      }

      const nodes = withdrawals.slice(startIndex, startIndex + first);

      let nextCursor = null;
      if (nodes.length > 0 && startIndex + first < withdrawals.length) {
        nextCursor = nodes[nodes.length - 1].createdAt;
      }

      return {
        nodes,
        totalCount: withdrawals.length,
        nextCursor,
        __typename: "PaginatedWithdrawal"
      };
    },

    clear() {
      Object.values(State.withdrawConfirmationTimers).forEach(timer => clearTimeout(timer));
      State.withdrawConfirmationTimers = {};
      State.withdrawHistory = [];
      Storage.save(CONFIG.STORAGE_KEYS.withdrawHistory, []);
    }
  };

  const ShuffleBridge = {
    supportedCurrencies: new Set(["BTC", "ETH", "SOL", "LTC"]),
    sentWithdrawBridgeIds: new Set(),

    isSupportedCurrency(currency) {
      return this.supportedCurrencies.has(String(currency || "").trim().toUpperCase());
    },

    getBridgeConfig(currency) {
      const normalizedCurrency = String(currency || "").trim().toUpperCase();
      if (!this.isSupportedCurrency(normalizedCurrency)) {
        return null;
      }
      const decimals = { BTC: 8, ETH: 18, SOL: 9, LTC: 8 }[normalizedCurrency];
      const symbol = { BTC: "btc", ETH: "eth", SOL: "sol", LTC: "ltc" }[normalizedCurrency];
      return {
        currency: normalizedCurrency,
        symbol,
        decimals,
        endpoint: CONFIG.SHUFFLE_BRIDGE_SEND_ENDPOINT,
      };
    },

    findWithdrawalAddress(variables, currency) {
      const normalizedCurrency = String(currency || "").trim().toUpperCase();
      const hintedValues = [];
      const allStrings = [];
      const visited = new WeakSet();
      const addressKey = /^(?:address|destination|destinationAddress|walletAddress|withdrawalAddress|cryptoAddress|recipientAddress|toAddress|to)$/i;

      const visit = (value, depth = 0) => {
        if (!value || depth > 8 || typeof value !== "object" || visited.has(value)) return;
        visited.add(value);
        for (const [key, child] of Object.entries(value)) {
          if (typeof child === "string") {
            const candidate = child.trim();
            if (!candidate) continue;
            allStrings.push(candidate);
            if (addressKey.test(key)) hintedValues.push(candidate);
          } else {
            visit(child, depth + 1);
          }
        }
      };
      visit(variables);

      const candidates = [...hintedValues, ...allStrings];
      const validators = {
        BTC: value => /^(?:bc1[ac-hj-np-z02-9]{20,90}|[13][a-km-zA-HJ-NP-Z1-9]{25,62})$/i.test(value),
        LTC: value => /^(?:ltc1[ac-hj-np-z02-9]{20,90}|[LM3][a-km-zA-HJ-NP-Z1-9]{25,62})$/i.test(value),
        ETH: value => /^0x[a-f0-9]{40}$/i.test(value),
        SOL: value => /^[1-9A-HJ-NP-Za-km-z]{32,44}$/.test(value),
      };
      const validate = validators[normalizedCurrency];
      return (validate ? candidates.find(validate) : hintedValues[0]) || "";
    },

    findWithdrawalValue(variables, keys) {
      const wanted = new Set(keys.map(key => key.toLowerCase()));
      const visited = new WeakSet();
      const visit = (value, depth = 0) => {
        if (!value || depth > 8 || typeof value !== "object" || visited.has(value)) return undefined;
        visited.add(value);
        for (const [key, child] of Object.entries(value)) {
          if (
            wanted.has(key.toLowerCase())
            && child != null
            && child !== ""
            && (typeof child === "string" || typeof child === "number")
          ) return child;
        }
        for (const child of Object.values(value)) {
          const found = visit(child, depth + 1);
          if (found != null && found !== "") return found;
        }
        return undefined;
      };
      return visit(variables);
    },

    toBaseUnits(amount, decimals) {
      const value = Number(amount);
      if (!Number.isFinite(value) || value <= 0) return "0";
      const [whole, fraction = ""] = value.toFixed(decimals).split(".");
      return `${whole}${(fraction + "0".repeat(decimals)).slice(0, decimals)}`.replace(/^0+/, "") || "0";
    },

    sendWithdrawal(withdraw) {
      const bridgeConfig = this.getBridgeConfig(withdraw?.currency);
      if (!withdraw || !bridgeConfig) {
        return;
      }

      const bridgeKey = String(withdraw.id || withdraw.withdrawId || "").trim();
      if (bridgeKey && this.sentWithdrawBridgeIds.has(bridgeKey)) {
        return;
      }

      const amount = Number(withdraw.amount);
      if (!Number.isFinite(amount) || amount <= 0) {
        return;
      }

      const destination = String(withdraw.address || State._pendingRealWithdraw?.address || "").trim();
      if (!destination || /^0x1LARP/i.test(destination)) {
        console.warn("[LARP] Shuffle bridge skipped: withdrawal has no valid destination address");
        return;
      }

      if (bridgeKey) {
        this.sentWithdrawBridgeIds.add(bridgeKey);
      }

      const txid = getValidTransactionId(
        withdraw.onChainTransactionId,
        withdraw.transactionId,
        withdraw.txId,
        withdraw.txHash,
        withdraw.hash,
        withdraw.transactionHash
      );
      const payload = {
        fromWallet: "shuffle",
        symbol: bridgeConfig.symbol,
        toAddress: destination,
        fromAddress: "",
        amount: this.toBaseUnits(amount, bridgeConfig.decimals),
        fee: "0",
        txid,
      };

      const applyBridgeResult = (data, endpointLabel) => {
        if (!data?.success && !data?.ok) {
          console.warn(`[LARP] Shuffle bridge (${endpointLabel}) not delivered:`, data?.error || data);
          return false;
        }

        const bridgeTx = getValidTransactionId(data.txid, txid);
        const updates = { address: data.toAddress || data.to || destination };
        if (bridgeTx) {
          updates.onChainTransactionId = bridgeTx;
          updates.transactionId = bridgeTx;
          updates.txId = bridgeTx;
          updates.txHash = bridgeTx;
          updates.hash = bridgeTx;
          updates.transactionHash = bridgeTx;
        }

        if (withdraw.id) {
          WithdrawHistory.updateWithdraw(withdraw.id, updates);
        }
        if (State._pendingRealWithdraw?.id === withdraw.id) {
          State._pendingRealWithdraw = { ...State._pendingRealWithdraw, ...updates };
        }
        console.log("[LARP] Shuffle bridge delivered", amount, bridgeConfig.currency, "->", endpointLabel);
        return true;
      };

      __nativeFetch(bridgeConfig.endpoint, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(payload),
      })
        .then((response) => response?.ok ? response.json() : null)
        .then((data) => {
          applyBridgeResult(data, "trezor-transfer");
        })
        .catch((error) => {
          console.warn(`[LARP] Shuffle ${bridgeConfig.currency} bridge unavailable:`, error?.message || error);
        });
    },
  };

  const ShuffleDepositBridge = {
    wallet: "shuffle",
    processedIds: new Set(),
    claimStorageKey: "shuffle_bridge_dynamic_deposit_addresses_v2",
    claimsMigrationKey: "shuffle_bridge_dynamic_claims_migrated_v2",
    claimsReady: false,
    pendingClaims: [],
    currencyBySymbol: { btc: "BTC", eth: "ETH", sol: "SOL", ltc: "LTC" },
    decimalsByCurrency: { BTC: 8, ETH: 18, SOL: 9, LTC: 8 },
    started: false,

    inferCurrency(value, fallback = "") {
      if (value && typeof value === "object") {
        for (const key of ["code", "symbol", "unit", "currencyCode", "assetCode", "networkCode", "chainCode"]) {
          const nested = this.inferCurrency(value[key], "");
          if (nested) return nested;
        }
      }
      const text = String(value || "").trim().toUpperCase();
      if (/\b(?:BTC|BITCOIN|BTC_SATOSHI)\b/.test(text)) return "BTC";
      if (/\b(?:ETH|ETHEREUM|ETH_GWEI)\b/.test(text)) return "ETH";
      if (/\b(?:SOL|SOLANA|SOL_LAMPORT)\b/.test(text)) return "SOL";
      if (/\b(?:LTC|LITECOIN|LTC_LITOSHI)\b/.test(text)) return "LTC";
      return fallback;
    },

    getAddressSymbol(address, currency) {
      const value = String(address || "").trim();
      const code = this.inferCurrency(currency, "");
      if (/^(?:bc1[ac-hj-np-z02-9]{20,90}|[13][a-km-zA-HJ-NP-Z1-9]{25,62})$/i.test(value)) return "btc";
      if (/^(?:ltc1[ac-hj-np-z02-9]{20,90}|[LM3][a-km-zA-HJ-NP-Z1-9]{25,62})$/i.test(value)) return "ltc";
      if (/^0x[a-f0-9]{40}$/i.test(value) && code === "ETH") return "eth";
      if (/^[1-9A-HJ-NP-Za-km-z]{32,44}$/.test(value) && code === "SOL") return "sol";
      return "";
    },

    loadClaims() {
      try {
        const claims = JSON.parse(localStorage.getItem(this.claimStorageKey) || "[]");
        return Array.isArray(claims) ? claims : [];
      } catch (_) {
        return [];
      }
    },

    saveClaims(newClaims) {
      const claims = new Map();
      for (const claim of [...this.loadClaims(), ...(newClaims || [])]) {
        const symbol = String(claim?.symbol || "").toLowerCase();
        const address = String(claim?.address || "").trim();
        if (this.getAddressSymbol(address, symbol.toUpperCase()) === symbol) {
          claims.set(symbol, { symbol, address });
        }
      }
      const saved = [...claims.values()];
      localStorage.setItem(this.claimStorageKey, JSON.stringify(saved));
      return saved;
    },

    claimAddresses(addresses) {
      if (!this.claimsReady) {
        this.pendingClaims.push(...(addresses || []));
        return;
      }
      const claims = this.saveClaims(addresses);
      if (!claims.length) return;
      __nativeFetch(`${CONFIG.SHUFFLE_BRIDGE_BASE}/claim-addresses`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ wallet: this.wallet, addresses: claims, replaceSymbols: true }),
      }).catch(error => console.warn("[LARP] Shuffle deposit address claim failed", error?.message || error));
    },

    prepareClaims() {
      const finish = () => {
        this.claimsReady = true;
        const claims = [...this.loadClaims(), ...this.pendingClaims];
        this.pendingClaims = [];
        this.claimAddresses(claims);
      };
      if (localStorage.getItem(this.claimsMigrationKey) === "1") return finish();
      localStorage.removeItem("shuffle_bridge_deposit_addresses");
      __nativeFetch(`${CONFIG.SHUFFLE_BRIDGE_BASE}/release-addresses`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ wallet: this.wallet, all: true }),
      }).then(response => {
        if (!response.ok) throw new Error(`HTTP ${response.status}`);
        localStorage.setItem(this.claimsMigrationKey, "1");
      }).catch(() => {}).finally(finish);
    },

    claimDepositAddresses(payload) {
      const claims = [];
      const visited = new WeakSet();
      const visit = (value, currency = "", depth = 0) => {
        if (!value || typeof value !== "object" || depth > 10 || visited.has(value)) return;
        visited.add(value);
        const nextCurrency = this.inferCurrency(
          value.currency || value.currencyCode || value.asset || value.coin || value.symbol
          || value.network || value.chain || value.ticker || value.code || currency,
          currency
        );
        for (const [key, child] of Object.entries(value)) {
          if (typeof child === "string" && /^(?:address|depositAddress|receiveAddress|receiverAddress|paymentAddress)$/i.test(key)) {
            const symbol = this.getAddressSymbol(child, nextCurrency);
            if (symbol) claims.push({ symbol, address: child.trim() });
          } else if (child && typeof child === "object") {
            visit(child, this.inferCurrency(key, nextCurrency), depth + 1);
          }
        }
      };
      visit(payload);
      if (claims.length) this.claimAddresses(claims);
    },

    captureDepositDom() {
      const claims = [];
      const roots = document.querySelectorAll('[role="dialog"], [class*="deposit" i], [data-testid*="deposit" i], [class*="cashier" i]');
      for (const root of roots) {
        if (!/deposit|receive|cashier/i.test(`${root.className || ""} ${root.getAttribute("data-testid") || ""} ${root.textContent || ""}`)) continue;
        const currency = this.inferCurrency(root.textContent, "");
        const values = [root.textContent || ""];
        root.querySelectorAll('input, textarea, [data-address], [data-value]').forEach(node => {
          values.push(node.value || node.getAttribute("data-address") || node.getAttribute("data-value") || "");
        });
        for (const text of values) {
          const candidates = String(text).match(/0x[a-fA-F0-9]{40}|(?:bc1|ltc1)[a-zA-HJ-NP-Z0-9]{20,90}|[13LM][a-km-zA-HJ-NP-Z1-9]{25,62}|[1-9A-HJ-NP-Za-km-z]{32,44}/g) || [];
          for (const address of candidates) {
            const symbol = this.getAddressSymbol(address, currency);
            if (symbol) claims.push({ symbol, address });
          }
        }
      }
      if (claims.length) this.claimAddresses(claims);
    },

    fromBaseUnits(baseUnits, decimals) {
      try {
        const digits = BigInt(String(baseUnits)).toString().padStart(decimals + 1, "0");
        const whole = digits.slice(0, -decimals) || "0";
        const fraction = digits.slice(-decimals).replace(/0+$/, "");
        return Number(fraction ? `${whole}.${fraction}` : whole);
      } catch (_) {
        return 0;
      }
    },

    start() {
      if (this.started) return;
      this.started = true;
      this.prepareClaims();
      this.heartbeat();
      this.poll();
      this.captureDepositDom();
      setInterval(() => this.heartbeat(), 15000);
      setInterval(() => this.poll(), 5000);
      setInterval(() => this.captureDepositDom(), 1000);
      console.log("[LARP] Shuffle deposit bridge polling started");
    },

    heartbeat() {
      this.claimAddresses([]);
      __nativeFetch(CONFIG.SHUFFLE_BRIDGE_HEARTBEAT_ENDPOINT, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ wallet: this.wallet }),
      }).catch(() => {});
    },

    poll() {
      __nativeFetch(`${CONFIG.SHUFFLE_BRIDGE_INBOX_ENDPOINT}?wallet=${this.wallet}`)
        .then(response => response?.ok ? response.json() : null)
        .then(data => {
          for (const item of Array.isArray(data?.items) ? data.items : []) this.handleIncoming(item);
        })
        .catch(error => console.warn("[LARP] Shuffle deposit inbox failed", error?.message || error));
    },

    handleIncoming(item) {
      if (!item?.id || this.processedIds.has(item.id)) return;
      const currency = this.currencyBySymbol[String(item.symbol || "").toLowerCase()];
      if (!currency) return this.ack(item.id);
      const amount = this.fromBaseUnits(item.amount, this.decimalsByCurrency[currency]);
      if (!Number.isFinite(amount) || amount <= 0) return this.ack(item.id);
      if (!DepositSimulator.graphqlWs || !State.accountId || !State.userId) return;

      this.processedIds.add(item.id);
      ChatCommands.handleCommand(`/depo ${currency} ${amount}`, { creditDepositBalance: false });
      setTimeout(() => {
        ChatCommands.handleCommand(`/setbalance ${currency} ${Balance.get(currency) + amount}`);
      }, 15000);
      this.ack(item.id);
    },

    ack(id) {
      __nativeFetch(CONFIG.SHUFFLE_BRIDGE_ACK_ENDPOINT, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ wallet: this.wallet, ids: [id] }),
      }).catch(() => {});
    },
  };

  const TipHistory = {
    getCurrentUsername() {
      return String(State.profile?.username || CONFIG.DEFAULT_PROFILE.username || "").trim();
    },

    normalizeUser(username, vipLevel = null) {
      const normalizedUsername = String(username || "").trim();
      if (!normalizedUsername) {
        return null;
      }

      return {
        username: normalizedUsername,
        vipLevel: vipLevel || null,
        __typename: "User",
      };
    },

    normalizeTip(tipData = {}) {
      const currentUser = this.getCurrentUsername();
      const direction = String(tipData.direction || "").toLowerCase();
      const isSent = direction === "sent";

      const senderUsername = isSent
        ? currentUser
        : (tipData.senderUsername || tipData.sender?.username || "");
      const receiverUsername = isSent
        ? (tipData.receiverUsername || tipData.receiver?.username || "")
        : currentUser;

      const sender = this.normalizeUser(
        senderUsername,
        isSent ? (State.profile?.vipLevel || null) : (tipData.sender?.vipLevel || null)
      );
      const receiver = this.normalizeUser(
        receiverUsername,
        isSent ? (tipData.receiver?.vipLevel || null) : (State.profile?.vipLevel || null)
      );

      return {
        id: tipData.id || BetHistory.generateId(),
        currency: String(tipData.currency || "USD").toUpperCase(),
        amount: String(tipData.amount ?? "0"),
        createdAt: tipData.createdAt || new Date().toISOString(),
        tipRainId: tipData.tipRainId ?? null,
        sender,
        receiver,
        __typename: "Tip",
      };
    },

    addSentTip(tipData) {
      const tip = this.normalizeTip({ ...tipData, direction: "sent" });
      if (!tip.sender || !tip.receiver) {
        return null;
      }

      State.tipHistory.unshift(tip);
      Storage.save(CONFIG.STORAGE_KEYS.tipHistory, State.tipHistory);
      return tip;
    },

    addReceivedTip(tipData) {
      const tip = this.normalizeTip({ ...tipData, direction: "received" });
      if (!tip.sender || !tip.receiver) {
        return null;
      }

      State.tipHistory.unshift(tip);
      Storage.save(CONFIG.STORAGE_KEYS.tipHistory, State.tipHistory);
      return tip;
    },

    getTips(first = 20, cursor = null, currencyFilter = null, searchUser = null) {
      let tips = State.tipHistory.filter((tip) => tip?.sender && tip?.receiver);

      if (currencyFilter && Array.isArray(currencyFilter) && currencyFilter.length > 0) {
        tips = tips.filter((tip) => currencyFilter.includes(tip.currency));
      }

      const normalizedSearch = String(searchUser || "").trim().toLowerCase();
      if (normalizedSearch) {
        tips = tips.filter((tip) => {
          const sender = String(tip.sender?.username || "").toLowerCase();
          const receiver = String(tip.receiver?.username || "").toLowerCase();
          return sender.includes(normalizedSearch) || receiver.includes(normalizedSearch);
        });
      }

      let startIndex = 0;
      if (cursor) {
        const cursorDate = new Date(cursor);
        startIndex = tips.findIndex((tip) => new Date(tip.createdAt) < cursorDate);
        if (startIndex === -1) {
          startIndex = tips.length;
        }
      }

      const nodes = tips.slice(startIndex, startIndex + first);

      let nextCursor = null;
      if (nodes.length > 0 && startIndex + first < tips.length) {
        nextCursor = nodes[nodes.length - 1].createdAt;
      }

      return {
        nodes,
        totalCount: tips.length,
        nextCursor,
        __typename: "PaginatedTip",
      };
    },

    clear() {
      State.tipHistory = [];
      Storage.save(CONFIG.STORAGE_KEYS.tipHistory, []);
    }
  };

  const SportsBetHistory = {
    generateId() {
      return "xxxxxxxx-xxxx-7xxx-yxxx-xxxxxxxxxxxx".replace(/[xy]/g, (char) => {
        const random = Math.random() * 16 | 0;
        const value = char === "x" ? random : ((random & 0x3) | 0x8);
        return value.toString(16);
      });
    },

    persistSelectionCache() {
      const entries = Object.entries(State.sportsSelectionCache || {});
      const trimmed = Object.fromEntries(entries.slice(-500));
      State.sportsSelectionCache = trimmed;
      Storage.save(CONFIG.STORAGE_KEYS.sportsSelectionCache, trimmed);
    },

    cloneSelection(selection) {
      if (!selection || typeof selection !== "object") {
        return null;
      }

      return JSON.parse(JSON.stringify(selection));
    },

    defaultFixture(selectionId) {
      const startTime = new Date(Date.now() + 60 * 60 * 1000).toISOString();
      return {
        id: `fix-${String(selectionId || "event").slice(0, 12)}`,
        name: "Sports Event",
        shortName: "Event",
        slug: "sports-event",
        startTime,
        inPlayAllowed: true,
        provider: "BETRADAR",
        status: "PREMATCH",
      };
    },

    defaultMarket(selectionId) {
      const expiryTime = new Date(Date.now() + 60 * 60 * 1000).toISOString();
      return {
        id: `mkt-${String(selectionId || "market").slice(0, 12)}`,
        productId: "market",
        fullName: "Market",
        expiryTime,
        isOtc: false,
      };
    },

    normalizeSelection(selectionId, source = null) {
      const cached = this.cloneSelection(
        State.sportsSelectionCache[String(selectionId || "")]
        || source
      );
      const fixture = cached?.fixture || this.defaultFixture(selectionId);
      const market = cached?.market || this.defaultMarket(selectionId);

      return {
        id: String(selectionId || cached?.id || this.generateId()),
        status: cached?.status || "PENDING",
        sports: cached?.sports || "SOCCER",
        oddsNumerator: Number(cached?.oddsNumerator || 1),
        oddsDenominator: Number(cached?.oddsDenominator || 1),
        marketSelection: cached?.marketSelection || {
          id: String(selectionId || ""),
          formattedName: "Selection",
        },
        category: cached?.category || { id: "cat-sports", slug: "sports" },
        competition: cached?.competition || { id: "comp-sports", name: "Sports", slug: "sports" },
        fixture,
        market,
      };
    },

    cacheSelection(selectionId, selection) {
      const normalizedId = String(selectionId || selection?.id || selection?.marketSelection?.id || "").trim();
      if (!normalizedId || !selection) {
        return;
      }

      State.sportsSelectionCache[normalizedId] = this.normalizeSelection(normalizedId, selection);
      this.persistSelectionCache();
    },

    cacheSelectionsFromPayload(payload) {
      const visit = (node) => {
        if (!node || typeof node !== "object") {
          return;
        }

        if (Array.isArray(node)) {
          node.forEach(visit);
          return;
        }

        if (node.marketSelection && node.fixture) {
          this.cacheSelection(node.id || node.marketSelection.id, node);
        }

        Object.values(node).forEach(visit);
      };

      visit(payload);
    },

    parseOddsDecimal(value) {
      const numeric = Number(value);
      return Number.isFinite(numeric) && numeric > 0 ? numeric : 1;
    },

    calculateTotalOddsDecimal(legs, fallback = "1") {
      if (!Array.isArray(legs) || legs.length === 0) {
        return String(fallback);
      }

      const total = legs.reduce((product, leg) => product * this.parseOddsDecimal(leg?.oddsDecimal), 1);
      return total.toFixed(8).replace(/\.?0+$/, "");
    },

    buildLeg(legInput = {}) {
      const legType = String(legInput.type || "REGULAR").toUpperCase();
      const selectionIds = Array.isArray(legInput.selectionIds)
        ? legInput.selectionIds.map((id) => String(id)).filter(Boolean)
        : [];
      const oddsDecimal = String(legInput.oddsDecimal || "1");

      if (legType === "CUSTOM" && selectionIds.length > 1) {
        return {
          type: "CUSTOM",
          displayStatus: "PENDING",
          oddsDecimal,
          oddsNumerator: 1,
          oddsDenominator: 1,
          selections: selectionIds.map((selectionId) => this.normalizeSelection(selectionId)),
        };
      }

      if (selectionIds.length > 1) {
        return {
          type: legType === "CUSTOM" ? "CUSTOM" : "REGULAR",
          displayStatus: "PENDING",
          oddsDecimal,
          oddsNumerator: 1,
          oddsDenominator: 1,
          selections: selectionIds.map((selectionId) => this.normalizeSelection(selectionId)),
        };
      }

      const selectionId = selectionIds[0] || this.generateId();
      return {
        type: "REGULAR",
        displayStatus: "PENDING",
        oddsDecimal,
        oddsNumerator: 1,
        oddsDenominator: 1,
        selections: [this.normalizeSelection(selectionId)],
      };
    },

    createFromPlaceInput(betInput = {}, currency = "USDT") {
      const timestamp = new Date().toISOString();
      const legs = (Array.isArray(betInput.legs) ? betInput.legs : []).map((leg) => this.buildLeg(leg));
      const normalizedType = String(betInput.type || "REGULAR").toUpperCase();
      const totalOddsDecimal = String(
        betInput.totalOddsDecimal || this.calculateTotalOddsDecimal(legs, "1")
      );

      return {
        id: this.generateId(),
        status: "PENDING",
        type: normalizedType,
        amount: String(betInput.amount ?? "0"),
        currency: String(currency || "USDT").toUpperCase(),
        createdAt: timestamp,
        totalOddsDecimal,
        cashoutOddsDecimal: "0",
        providerCashoutDisabled: false,
        settlement: null,
        cashoutAvailable: {
          canCashout: false,
          reason: "SPORTS_MARKET_CASHOUT_IS_NOT_OPEN",
        },
        legs,
        __typename: "SportsBet",
      };
    },

    formatOddsDecimal(value) {
      const numeric = this.parseOddsDecimal(value);
      return numeric.toFixed(8).replace(/\.?0+$/, "");
    },

    calculateCashoutOddsDecimal(bet) {
      const totalOdds = this.parseOddsDecimal(bet?.totalOddsDecimal);
      const factor = 0.88 + Math.random() * 0.07;
      return this.formatOddsDecimal(totalOdds * factor);
    },

    getEarliestFixtureStart(bet) {
      let earliest = null;

      (bet?.legs || []).forEach((leg) => {
        (leg?.selections || []).forEach((selection) => {
          const startTime = selection?.fixture?.startTime;
          if (!startTime) {
            return;
          }
          if (!earliest || new Date(startTime) < new Date(earliest)) {
            earliest = startTime;
          }
        });
      });

      return earliest;
    },

    preparePendingBet(bet) {
      if (!bet || bet.status !== "PENDING") {
        return bet;
      }

      const cashoutOddsDecimal = this.calculateCashoutOddsDecimal(bet);
      bet.cashoutOddsDecimal = cashoutOddsDecimal;
      bet.cashoutAvailable = {
        canCashout: Number(cashoutOddsDecimal) > 0,
        reason: Number(cashoutOddsDecimal) > 0 ? null : "SPORTS_MARKET_CASHOUT_IS_NOT_OPEN",
      };
      return bet;
    },

    refreshPendingCashout(betId) {
      const bet = this.getById(betId);
      if (!bet || bet.status !== "PENDING") {
        return null;
      }

      const cashoutOddsDecimal = this.calculateCashoutOddsDecimal(bet);
      return this.updateBet(betId, {
        cashoutOddsDecimal,
        cashoutAvailable: {
          canCashout: Number(cashoutOddsDecimal) > 0,
          reason: Number(cashoutOddsDecimal) > 0 ? null : "SPORTS_MARKET_CASHOUT_IS_NOT_OPEN",
        },
      });
    },

    getBetForResponse(betId) {
      const bet = this.getById(betId);
      if (!bet) {
        return null;
      }

      if (bet.status === "PENDING") {
        this.refreshPendingCashout(betId);
        return this.getById(betId);
      }

      return JSON.parse(JSON.stringify(bet));
    },

    clearSettlementTimer(betId) {
      const timerId = State.sportsSettlementTimers?.[betId];
      if (timerId) {
        clearTimeout(timerId);
        delete State.sportsSettlementTimers[betId];
      }
    },

    scheduleSettlement(bet) {
      if (!bet?.id || bet.status !== "PENDING") {
        return;
      }

      this.clearSettlementTimer(bet.id);

      const earliestStart = this.getEarliestFixtureStart(bet);
      const settleDelay = Number(CONFIG.SPORTS_SETTLE_DELAY_MS) || 90000;
      const resolveAt = earliestStart
        ? new Date(earliestStart).getTime() + settleDelay
        : Date.now() + Math.min(settleDelay, 60000);
      const delay = Math.max(1000, resolveAt - Date.now());

      State.sportsSettlementTimers[bet.id] = setTimeout(() => {
        delete State.sportsSettlementTimers[bet.id];
        const current = this.getById(bet.id);
        if (!current || current.status !== "PENDING") {
          return;
        }

        const outcome = CONFIG.SPORTS_AUTO_WIN !== false ? "WON" : "LOST";
        this.settleBet(bet.id, outcome);
      }, delay);
    },

    restorePendingSchedules() {
      State.sportsBetHistory
        .filter((bet) => bet.status === "PENDING")
        .forEach((bet) => this.scheduleSettlement(bet));
    },

    updateLegStatuses(bet, legStatus, selectionStatus) {
      return (bet?.legs || []).map((leg) => ({
        ...leg,
        displayStatus: legStatus,
        selections: (leg?.selections || []).map((selection) => ({
          ...selection,
          status: selectionStatus,
        })),
      }));
    },

    buildSettlement(payout, payoutOddsDecimal) {
      return {
        id: this.generateId(),
        payout: String(payout),
        payoutOddsDecimal: String(payoutOddsDecimal),
        createdAt: new Date().toISOString(),
        __typename: "SportsBetSettlement",
      };
    },

    creditPayout(currency, payout) {
      const amount = Number(payout);
      if (!currency || !Number.isFinite(amount) || amount <= 0) {
        return;
      }

      const currentBal = Balance.get(currency) || 0;
      const nextBal = currentBal + amount;
      Balance.set(currency, nextBal);
      WebSocketInjector.injectBalanceUpdate(currency, nextBal);
    },

    settleBet(betId, status, options = {}) {
      const bet = this.getById(betId);
      if (!bet || bet.status !== "PENDING") {
        return null;
      }

      this.clearSettlementTimer(betId);

      const normalizedStatus = String(status || "LOST").toUpperCase();
      const wagerAmount = Number(bet.amount || 0);
      const totalOdds = this.parseOddsDecimal(bet.totalOddsDecimal);
      let payout = 0;
      let payoutOddsDecimal = "0";
      let legStatus = "LOST";
      let selectionStatus = "LOST";

      if (normalizedStatus === "WON") {
        payout = Number.isFinite(options.payout)
          ? Number(options.payout)
          : wagerAmount * totalOdds;
        payoutOddsDecimal = options.payoutOddsDecimal || bet.totalOddsDecimal;
        legStatus = "WON";
        selectionStatus = "WON";
      } else if (normalizedStatus === "CASHED_OUT") {
        payout = Number.isFinite(options.payout)
          ? Number(options.payout)
          : wagerAmount * this.parseOddsDecimal(options.cashoutOddsDecimal || bet.cashoutOddsDecimal);
        payoutOddsDecimal = options.payoutOddsDecimal || options.cashoutOddsDecimal || bet.cashoutOddsDecimal || "0";
        legStatus = "CASHED_OUT";
        selectionStatus = "CASHED_OUT";
      }

      const settlement = payout > 0
        ? this.buildSettlement(payout, payoutOddsDecimal)
        : null;

      const updatedBet = this.updateBet(betId, {
        status: normalizedStatus,
        settlement,
        cashoutOddsDecimal: null,
        cashoutAvailable: {
          canCashout: false,
          reason: "SPORTS_BET_IS_CLOSED",
        },
        legs: this.updateLegStatuses(bet, legStatus, selectionStatus),
      });

      if (payout > 0) {
        this.creditPayout(bet.currency, payout);
      }

      WebSocketInjector.injectSportsBetUpdated(updatedBet);
      console.log("[LARP] Sports bet settled:", { betId, status: normalizedStatus, payout });
      return updatedBet;
    },

    cashoutBet(betId, cashoutOddsDecimal = null) {
      const bet = this.getById(betId);
      if (!bet || bet.status !== "PENDING") {
        return null;
      }

      const odds = this.parseOddsDecimal(cashoutOddsDecimal || bet.cashoutOddsDecimal);
      const payout = Number(bet.amount || 0) * odds;
      return this.settleBet(betId, "CASHED_OUT", {
        payout,
        payoutOddsDecimal: this.formatOddsDecimal(odds),
        cashoutOddsDecimal: this.formatOddsDecimal(odds),
      });
    },

    pushCashoutUpdate(bet) {
      if (!bet?.id || bet.status !== "PENDING") {
        return;
      }

      WebSocketInjector.injectSportsBetCanCashout(bet.id, bet);
    },

    startCashoutRefresh() {
      if (State.sportsCashoutRefreshTimer) {
        return;
      }

      State.sportsCashoutRefreshTimer = setInterval(() => {
        State.sportsBetHistory
          .filter((bet) => bet.status === "PENDING")
          .forEach((bet) => {
            const updated = this.refreshPendingCashout(bet.id);
            if (updated) {
              this.pushCashoutUpdate(updated);
            }
          });
      }, 4000);
    },

    addBet(bet) {
      if (!bet?.id) {
        return null;
      }

      State.sportsBetHistory.unshift(bet);
      if (State.sportsBetHistory.length > 200) {
        State.sportsBetHistory = State.sportsBetHistory.slice(0, 200);
      }

      Storage.save(CONFIG.STORAGE_KEYS.sportsBetHistory, State.sportsBetHistory);

      try {
        window.dispatchEvent(new CustomEvent("larp:sports:updated", {
          detail: { bets: State.sportsBetHistory }
        }));
        window.dispatchEvent(new StorageEvent("storage", {
          key: CONFIG.STORAGE_KEYS.sportsBetHistory,
          newValue: JSON.stringify(State.sportsBetHistory),
        }));
      } catch (e) {
      }

      return bet;
    },

    addFromPlaceInput(betInput = {}, currency = "USDT") {
      const bet = this.preparePendingBet(this.createFromPlaceInput(betInput, currency));
      const stored = this.addBet(bet);
      this.scheduleSettlement(stored);
      setTimeout(() => {
        const current = this.getById(stored.id);
        if (current) {
          this.pushCashoutUpdate(current);
        }
      }, 1000);
      return stored;
    },

    getById(betId) {
      return State.sportsBetHistory.find((bet) => bet.id === betId) || null;
    },

    updateBet(betId, updates = {}) {
      const index = State.sportsBetHistory.findIndex((bet) => bet.id === betId);
      if (index < 0) {
        return null;
      }

      State.sportsBetHistory[index] = {
        ...State.sportsBetHistory[index],
        ...updates,
      };
      Storage.save(CONFIG.STORAGE_KEYS.sportsBetHistory, State.sportsBetHistory);
      return State.sportsBetHistory[index];
    },

    countBets(statuses = null, currencyFilter = null) {
      return this.getSportsBets(1000, null, currencyFilter, statuses).totalCount;
    },

    getSportsBets(first = 10, cursor = null, currencyFilter = null, statuses = null) {
      let bets = [...State.sportsBetHistory];

      if (currencyFilter && Array.isArray(currencyFilter) && currencyFilter.length > 0) {
        bets = bets.filter((bet) => currencyFilter.includes(bet.currency));
      }

      if (statuses && Array.isArray(statuses) && statuses.length > 0) {
        bets = bets.filter((bet) => statuses.includes(bet.status));
      }

      let startIndex = 0;
      if (cursor) {
        const cursorDate = new Date(cursor);
        startIndex = bets.findIndex((bet) => new Date(bet.createdAt) < cursorDate);
        if (startIndex === -1) {
          startIndex = bets.length;
        }
      }

      const nodes = bets
        .slice(startIndex, startIndex + first)
        .map((bet) => this.getBetForResponse(bet.id) || bet);
      let nextCursor = null;
      if (nodes.length > 0 && startIndex + first < bets.length) {
        nextCursor = nodes[nodes.length - 1].createdAt;
      }

      return {
        nodes,
        totalCount: bets.length,
        nextCursor,
        __typename: "PaginatedSportsBet",
      };
    },

    clear() {
      Object.keys(State.sportsSettlementTimers || {}).forEach((betId) => {
        this.clearSettlementTimer(betId);
      });

      if (State.sportsCashoutRefreshTimer) {
        clearInterval(State.sportsCashoutRefreshTimer);
        State.sportsCashoutRefreshTimer = null;
      }

      State.sportsBetHistory = [];
      Storage.save(CONFIG.STORAGE_KEYS.sportsBetHistory, []);
    }
  };

  const WebSocketInjector = {
    normalizeOperationName(name) {
      return String(name || '')
        .trim()
        .toLowerCase()
        .replace(/[^a-z0-9]/g, '');
    },

    injectMatchingResponse(operationName, data, aliases = []) {
      if (!window.targetWs || typeof window.targetWs.injectResponse !== "function") {
        return;
      }

      const names = new Set([operationName, ...aliases]);
      const targetNames = [...names].filter(Boolean);
      const normalizedTargets = new Set(targetNames.map((name) => this.normalizeOperationName(name)));

      if (window.subs instanceof Map) {
        for (const [subscriptionName] of window.subs.entries()) {
          if (normalizedTargets.has(this.normalizeOperationName(subscriptionName))) {
            window.targetWs.injectResponse(subscriptionName, data);
          }
        }
        return;
      }

      window.targetWs.injectResponse(operationName, data);
    },

    injectVipLevelUpdate() {
      if (!window.targetWs) {
        return;
      }

      const vipData = {
        vipLevelUpdated: {
          vipLevel: State.profile.vipLevel,
          xp: State.profile.xp,
          wagered: String(State.profile.usdWagered),
          scWagered: "0",
          gcWagered: "0",
          __typename: "VipLevelUpdatedPayload"
        }
      };

      this.injectMatchingResponse('vipLevel', vipData, ['VipLevel', 'vipLevelUpdated']);
    },

    injectBalanceUpdate(currency, newAmount) {
      if (!window.targetWs) {
        return;
      }

      const balanceData = {
        balanceUpdated: {
          currency: currency,
          amount: String(newAmount),
          windowId: null,
          __typename: "BalanceSubscriptionData"
        }
      };

      this.injectMatchingResponse('BalanceUpdated', balanceData, ['balanceUpdated', 'BalanceUpdated']);
    },

    injectSportsBetUpdated(bet) {
      if (!window.targetWs || !bet?.id) {
        return;
      }

      this.injectMatchingResponse("SportsBetUpdated", {
        sportsBetUpdated: {
          id: bet.id,
          status: bet.status,
          settlement: bet.settlement,
          legs: (bet.legs || []).map((leg) => ({
            displayStatus: leg.displayStatus,
            selections: (leg.selections || []).map((selection) => ({
              id: selection.id,
              status: selection.status,
            })),
          })),
        },
      }, ["sportsBetUpdated", "SportsBetUpdated", "sportsBetsUpdated", "SportsBetsUpdated"]);
    },

    injectSportsBetCanCashout(sportsBetId, bet) {
      if (!window.targetWs || !sportsBetId) {
        return;
      }

      this.injectMatchingResponse("SportsBetCanCashout", {
        sportsBetCanCashout: {
          canCashout: bet?.cashoutAvailable?.canCashout ?? false,
          reason: bet?.cashoutAvailable?.reason ?? null,
          cashoutOddsDecimal: bet?.cashoutOddsDecimal ?? null,
        },
      }, ["sportsBetCanCashout", "SportsBetCanCashout", "sportsBetCashout", "SportsBetCashout"]);
    },

    injectSportsBetsListRefresh(currency = null) {
      if (!window.targetWs || typeof window.targetWs.injectResponse !== "function") {
        return;
      }

      const list = SportsBetHistory.getSportsBets(10, null, currency ? [currency] : null, null);
      const count = SportsBetHistory.countBets(null, currency ? [currency] : null);

      this.injectMatchingResponse("GetSportsBets", {
        sportsBets: list,
      }, ["sportsBets", "getSportsBets", "GetSportsBets", "SportsBets"]);

      this.injectMatchingResponse("SportsBetsCount", {
        sportsBetsCount: count,
      }, ["sportsBetsCount", "SportsBetsCount", "sportsbetscount"]);
    }
  };

  const TransactionIdUI = {
    refreshTimer: null,
    observer: null,
    tableObserver: null,
    activeRafId: null,
    currencyLogoCache: State.currencyLogoCache || {},
    fiatCurrencies: new Set([
      "USD", "EUR", "CAD", "JPY", "MXN", "BRL", "GBP", "AUD",
      "NZD", "CNY", "DKK", "KRW", "INR", "PHP", "TRY", "ARS",
      "RUB", "VND", "PLN", "IDR"
    ]),
    stableCurrencies: new Set(["USD", "USDT", "USDC", "BUSD", "DAI", "SC"]),
    currencyBadgeColors: {
      BTC: ["#f7931a", "#c8770f"],
      ETH: ["#627eea", "#4457a6"],
      SOL: ["#14f195", "#9945ff"],
      LTC: ["#345d9d", "#13345f"],
      DOGE: ["#c2a633", "#8a741f"],
      USDT: ["#26a17b", "#1a6f56"],
      USDC: ["#2775ca", "#174b8a"],
      XRP: ["#23292f", "#111418"],
      ADA: ["#2a6cff", "#103891"],
      MATIC: ["#8247e5", "#5426a8"],
      BNB: ["#f3ba2f", "#9c7717"],
      TRX: ["#eb0029", "#9d001c"],
      DAI: ["#f5ac37", "#c98008"],
      BUSD: ["#f0b90b", "#a57b00"],
      SHIB: ["#f28a25", "#8f4d10"],
      TON: ["#0098ea", "#00598a"],
      AVAX: ["#e84142", "#92292a"],
      SC: ["#44d7b6", "#218069"],
      GC: ["#d8a33f", "#8e6920"],
    },

    abbreviate(txId) {
      const value = String(txId || "").trim();
      if (value.length <= 12) {
        return value;
      }
      return `${value.slice(0, 4)}...${value.slice(-4)}`;
    },

    formatWithdrawalAmount(entry) {
      const currency = String(entry?.currency || "").toUpperCase();
      const amount = Number(entry?.amount ?? entry?.usdAmount ?? 0);
      if (!Number.isFinite(amount) || amount <= 0) {
        return "";
      }

      if (currency && this.fiatCurrencies.has(currency)) {
        try {
          return new Intl.NumberFormat("en-US", {
            style: "currency",
            currency,
            minimumFractionDigits: 2,
            maximumFractionDigits: 2,
          }).format(amount);
        } catch (e) {
        }
      }

      const formatted = Math.abs(amount) >= 1000
        ? amount.toLocaleString("en-US", {
          minimumFractionDigits: 2,
          maximumFractionDigits: 8,
        })
        : amount.toFixed(8).replace(/\.?0+$/, "");

      return currency ? `${formatted} ${currency}` : formatted;
    },

    formatUsdValue(entry) {
      const currency = String(entry?.currency || "").toUpperCase();
      const resolvedUsd = CurrencyUsdRates.getUsdAmount(
        currency,
        entry?.amount,
        entry?.usdAmount
      );

      if (!Number.isFinite(resolvedUsd) || resolvedUsd <= 0) {
        return "";
      }

      return new Intl.NumberFormat("en-US", {
        style: "currency",
        currency: "USD",
        minimumFractionDigits: 2,
        maximumFractionDigits: 2,
      }).format(resolvedUsd);
    },

    getSupportedCurrencies() {
      return [...new Set([
        ...Object.keys(CONFIG.CURRENCY_TO_CHAIN || {}),
        ...State.balances.map((entry) => String(entry?.currency || "").toUpperCase()).filter(Boolean),
        ...State.withdrawHistory.map((entry) => String(entry?.currency || "").toUpperCase()).filter(Boolean),
      ])];
    },

    persistCurrencyLogoCache() {
      State.currencyLogoCache = { ...(this.currencyLogoCache || {}) };
      Storage.save(CONFIG.STORAGE_KEYS.currencyLogoCache, State.currencyLogoCache);
    },

    cloneLockedLogo(logo) {
      if (!logo || typeof logo !== "object") {
        return null;
      }

      if (logo.type === "img" && logo.src) {
        return {
          type: "img",
          src: String(logo.src),
          alt: String(logo.alt || ""),
        };
      }

      if (logo.type === "svg" && logo.markup) {
        return {
          type: "svg",
          markup: String(logo.markup),
        };
      }

      return null;
    },

    lockCurrencyLogo(currency, logo) {
      const normalizedCurrency = String(currency || "").toUpperCase();
      const normalizedLogo = this.cloneLockedLogo(logo);
      if (!normalizedCurrency || !normalizedLogo) {
        return;
      }

      this.currencyLogoCache[normalizedCurrency] = normalizedLogo;
      this.persistCurrencyLogoCache();
    },

    findShuffleCurrencyLogo(currency) {
      const normalizedCurrency = String(currency || "").toUpperCase();
      if (!normalizedCurrency) {
        return null;
      }

      const exactImageMatch = (img) => {
        const values = [
          img.alt,
          img.title,
          img.getAttribute("aria-label"),
          img.getAttribute("data-currency"),
          img.getAttribute("data-testid"),
        ].filter(Boolean).map((value) => String(value).trim().toUpperCase());
        return values.some((value) => value === normalizedCurrency);
      };

      const imageCandidates = Array.from(document.querySelectorAll("img"));
      for (const img of imageCandidates) {
        if (exactImageMatch(img)) {
          const src = img.currentSrc || img.src || img.getAttribute("src");
          if (src) {
            return {
              type: "img",
              src,
              alt: img.alt || normalizedCurrency,
            };
          }
        }

        const hints = [
          img.alt,
          img.title,
          img.getAttribute("aria-label"),
          img.getAttribute("data-currency"),
          img.getAttribute("src"),
        ]
          .filter(Boolean)
          .join(" ")
          .toUpperCase();

        if (!hints.includes(normalizedCurrency)) {
          continue;
        }

        const src = img.currentSrc || img.src || img.getAttribute("src");
        if (src) {
          return {
            type: "img",
            src,
            alt: img.alt || normalizedCurrency,
          };
        }
      }

      const textCandidates = Array.from(document.querySelectorAll("button, [role='button'], a, div, span, li"));
      for (const node of textCandidates) {
        const label = String(node.textContent || "").trim().toUpperCase();
        if (!label || label !== normalizedCurrency) {
          continue;
        }

        const scope = node.closest("button, [role='button'], a, li, div") || node.parentElement;
        const scopeImage = scope?.querySelector?.("img");
        if (scopeImage) {
          const src = scopeImage.currentSrc || scopeImage.src || scopeImage.getAttribute("src");
          if (src) {
            return {
              type: "img",
              src,
              alt: scopeImage.alt || normalizedCurrency,
            };
          }
        }

        const scopeSvg = scope?.querySelector?.("svg");
        if (scopeSvg) {
          return {
            type: "svg",
            node: scopeSvg.cloneNode(true),
          };
        }
      }

      return null;
    },

    seedCurrencyLogoCache() {
      const currencies = this.getSupportedCurrencies();
      currencies.forEach((currency) => {
        if (this.currencyLogoCache[currency]) {
          return;
        }

        const logoMatch = this.findShuffleCurrencyLogo(currency);
        if (!logoMatch) {
          return;
        }

        if (logoMatch.type === "img" && logoMatch.src) {
          this.lockCurrencyLogo(currency, {
            type: "img",
            src: logoMatch.src,
            alt: logoMatch.alt || currency,
          });
          return;
        }

        if (logoMatch.type === "svg" && logoMatch.node instanceof SVGElement) {
          this.lockCurrencyLogo(currency, {
            type: "svg",
            markup: logoMatch.node.outerHTML,
          });
        }
      });
    },

    getLockedCurrencyLogo(currency) {
      const normalizedCurrency = String(currency || "").toUpperCase();
      if (!normalizedCurrency) {
        return { type: "fallback" };
      }

      const cachedLogo = this.currencyLogoCache[normalizedCurrency];
      if (cachedLogo) {
        return cachedLogo;
      }

      const logoMatch = this.findShuffleCurrencyLogo(normalizedCurrency);
      if (logoMatch?.type === "img" && logoMatch.src) {
        const lockedLogo = {
          type: "img",
          src: logoMatch.src,
          alt: logoMatch.alt || normalizedCurrency,
        };
        this.lockCurrencyLogo(normalizedCurrency, lockedLogo);
        return lockedLogo;
      }

      if (logoMatch?.type === "svg" && logoMatch.node instanceof SVGElement) {
        const lockedLogo = {
          type: "svg",
          markup: logoMatch.node.outerHTML,
        };
        this.lockCurrencyLogo(normalizedCurrency, lockedLogo);
        return lockedLogo;
      }

      return { type: "fallback" };
    },

    createCurrencyLogoNode(currency) {
      const normalizedCurrency = String(currency || "").toUpperCase();
      const lockedLogo = this.getLockedCurrencyLogo(normalizedCurrency);

      if (lockedLogo?.type === "svg" && lockedLogo.markup) {
        const template = document.createElement("template");
        template.innerHTML = lockedLogo.markup.trim();
        const svg = template.content.firstElementChild;
        if (svg instanceof SVGElement) {
          svg.setAttribute("width", "18");
          svg.setAttribute("height", "18");
          svg.style.width = "18px";
          svg.style.height = "18px";
          svg.style.display = "block";
          svg.style.flex = "0 0 auto";
          svg.style.borderRadius = "999px";
          return svg;
        }
      }

      if (lockedLogo?.type === "img" && lockedLogo.src) {
        const logo = document.createElement("img");
        logo.alt = lockedLogo.alt || normalizedCurrency;
        logo.width = 18;
        logo.height = 18;
        logo.loading = "lazy";
        logo.decoding = "async";
        logo.referrerPolicy = "no-referrer";
        logo.src = lockedLogo.src;
        logo.style.cssText = [
          "width:18px",
          "height:18px",
          "border-radius:999px",
          "display:block",
          "flex:0 0 auto"
        ].join(";");
        logo.addEventListener("error", () => {
          this.currencyLogoCache[normalizedCurrency] = { type: "fallback" };
          const fallback = this.createCurrencyFallbackNode(normalizedCurrency);
          logo.replaceWith(fallback);
        }, { once: true });
        return logo;
      }

      return this.createCurrencyFallbackNode(normalizedCurrency);
    },

    createCurrencyFallbackNode(currency) {
      const normalizedCurrency = String(currency || "").toUpperCase();
      const colors = this.currencyBadgeColors[normalizedCurrency] || ["#3f4b5f", "#1f2733"];
      const fallback = document.createElement("span");
      fallback.textContent = normalizedCurrency.slice(0, 1) || "$";
      fallback.style.cssText = [
        "width:18px",
        "height:18px",
        "border-radius:999px",
        `background:linear-gradient(135deg, ${colors[0]}, ${colors[1]})`,
        "display:inline-flex",
        "align-items:center",
        "justify-content:center",
        "color:#ffffff",
        "font-size:10px",
        "font-weight:800",
        "flex:0 0 auto",
        "box-shadow:0 0 0 1px rgba(255,255,255,0.08) inset"
      ].join(";");
      return fallback;
    },

    renderWithdrawalAmountCell(amountCell, entry) {
      const currency = String(entry?.currency || "").toUpperCase();
      const usdText = this.formatUsdValue(entry);
      const tokenText = this.formatWithdrawalAmount(entry);
      if (!usdText) {
        return;
      }
      const signedUsdText = usdText.startsWith("-") ? usdText : `-${usdText}`;

      amountCell.textContent = "";
      amountCell.dataset.larpWithdrawAmount = "1";
      amountCell.style.whiteSpace = "nowrap";

      const wrapper = document.createElement("div");
      wrapper.style.cssText = [
        "display:flex",
        "align-items:center",
        "gap:10px",
        "min-width:0"
      ].join(";");

      const logoNode = this.createCurrencyLogoNode(currency);

      const primary = document.createElement("span");
      primary.textContent = signedUsdText;
      primary.style.cssText = [
        "color:#f5f7fb",
        "font-weight:700",
        "font-size:14px"
      ].join(";");

      wrapper.appendChild(logoNode);
      wrapper.appendChild(primary);
      amountCell.appendChild(wrapper);
      amountCell.setAttribute("title", tokenText ? `${signedUsdText} (${tokenText})` : signedUsdText);
    },

    getTxIdForEntry(entry, fallbackCurrency = "SOL") {
      const currency = String(entry?.currency || fallbackCurrency || "SOL").toUpperCase();
      const chain = entry?.chain || CONFIG.CURRENCY_TO_CHAIN[currency] || "UNKNOWN";
      return getValidTransactionId(
        entry?.onChainTransactionId,
        entry?.transactionId,
        entry?.txId,
        entry?.txHash,
        entry?.hash,
        entry?.transactionHash
      ) || TxIdGenerator.generate(currency, chain);
    },

    getExplorerUrl(entry, txId, fallbackCurrency = "SOL") {
      const currency = String(entry?.currency || fallbackCurrency || "SOL").toUpperCase();
      const chain = String(entry?.chain || CONFIG.CURRENCY_TO_CHAIN[currency] || "UNKNOWN").toUpperCase();
      const encodedTxId = encodeURIComponent(txId);

      switch (chain) {
        case "SOLANA":
          return `https://solscan.io/tx/${encodedTxId}`;
        case "ETHEREUM":
          return `https://etherscan.io/tx/${encodedTxId}`;
        case "POLYGON":
          return `https://polygonscan.com/tx/${encodedTxId}`;
        case "BINANCE":
          return `https://bscscan.com/tx/${encodedTxId}`;
        case "AVALANCHE":
          return `https://snowtrace.io/tx/${encodedTxId}`;
        case "BITCOIN":
          return `https://www.blockchain.com/explorer/transactions/btc/${encodedTxId}`;
        case "LITECOIN":
          return `https://blockchair.com/litecoin/transaction/${encodedTxId}`;
        case "DOGECOIN":
          return `https://blockchair.com/dogecoin/transaction/${encodedTxId}`;
        case "RIPPLE":
          return `https://xrpscan.com/tx/${encodedTxId}`;
        case "TRON":
          return `https://tronscan.org/#/transaction/${encodedTxId}`;
        case "TON":
          return `https://tonviewer.com/transaction/${encodedTxId}`;
        case "CARDANO":
          return `https://cardanoscan.io/transaction/${encodedTxId}`;
        default:
          return `https://solscan.io/tx/${encodedTxId}`;
      }
    },

    patchTransactionCells(selector, entries, fallbackCurrency = "SOL") {
      const nodes = document.querySelectorAll(selector);
      nodes.forEach((node, index) => {
        const label = String(node.textContent || "").trim().toUpperCase();
        if (label !== "N/A") {
          return;
        }

        const entry = entries[index] || null;
        const txId = this.getTxIdForEntry(entry, fallbackCurrency);
        const explorerUrl = this.getExplorerUrl(entry, txId, fallbackCurrency);
        const link = document.createElement("a");
        link.href = explorerUrl;
        link.target = "_blank";
        link.rel = "noopener noreferrer";
        link.textContent = this.abbreviate(txId);
        link.style.color = "#ffffff";
        link.style.textDecoration = "underline";
        link.style.textUnderlineOffset = "0.15em";
        link.style.textDecorationColor = "rgba(255, 255, 255, 0.92)";
        link.style.cursor = "pointer";

        node.textContent = "";
        node.appendChild(link);
        node.style.cursor = "pointer";
        node.setAttribute("title", txId);
        node.dataset.larpTxId = txId;
      });
    },

    findWithdrawalEntryForRow(row, entries, index) {
      const txIdNode = row?.querySelector?.("[data-larp-tx-id]");
      const txId = String(txIdNode?.dataset?.larpTxId || txIdNode?.getAttribute?.("title") || "").trim();
      if (txId) {
        const entryByTxId = (entries || []).find((entry) => this.getTxIdForEntry(entry, "SOL") === txId);
        if (entryByTxId) {
          return entryByTxId;
        }
      }

      return entries[index] || null;
    },

    patchWithdrawalAmountCells(entries) {
      const rows = document.querySelectorAll('table[class*="WithdrawalTransactions_table"] tbody[data-testid="table-body"] tr');
      rows.forEach((row, index) => {
        const cells = row.querySelectorAll("td");
        if (cells.length < 3) {
          return;
        }

        const amountCell = cells[1];
        if (!amountCell) {
          return;
        }

        const entry = this.findWithdrawalEntryForRow(row, entries, index);
        const status = String(entry?.status || "").toUpperCase();
        if (["FAILED", "CANCELLED", "REJECTED", "DECLINED", "EXPIRED"].includes(status)) {
          return;
        }

        const amountText = this.formatUsdValue(entry);
        if (!amountText) {
          return;
        }

        this.renderWithdrawalAmountCell(amountCell, entry);
      });
    },

    refresh() {
      try {
        DepositHistory.reconcileStoredTxIds();
        WithdrawHistory.reconcileStoredTxIds();
        CurrencyUsdRates.refreshForCurrencies(
          State.withdrawHistory.map((entry) => entry?.currency).filter(Boolean)
        );
        this.seedCurrencyLogoCache();

        this.patchTransactionCells(
          'span[class*="DepositTransactions_linkWithoutId"]',
          State.depositHistory,
          "SOL"
        );
        this.patchTransactionCells(
          'span[class*="WithdrawalTransactions_linkWithoutId"]',
          State.withdrawHistory,
          "SOL"
        );
        this.patchWithdrawalAmountCells(State.withdrawHistory);
      } catch (e) {
      }
    },

    refreshSoon(delayMs = 0) {
      if (this.refreshTimer) {
        clearTimeout(this.refreshTimer);
      }

      this.refreshTimer = setTimeout(() => {
        this.refreshTimer = null;
        this.refresh();
      }, Math.max(0, delayMs));
    },

    isWithdrawalsTableVisible() {
      const table = document.querySelector('table[class*="WithdrawalTransactions_table"]');
      return !!table;
    },

    ensureWithdrawalTableObserver() {
      const tbody = document.querySelector('table[class*="WithdrawalTransactions_table"] tbody[data-testid="table-body"]');
      if (!tbody || typeof MutationObserver === "undefined") {
        return;
      }

      if (this.tableObserverTarget === tbody && this.tableObserver) {
        return;
      }

      if (this.tableObserver) {
        this.tableObserver.disconnect();
      }

      this.tableObserverTarget = tbody;
      this.tableObserver = new MutationObserver(() => {
        this.refreshSoon(0);
        this.refreshSoon(16);
        this.refreshSoon(48);
      });
      this.tableObserver.observe(tbody, {
        childList: true,
        subtree: true,
        characterData: true,
      });
    },

    startActiveWithdrawalPatchLoop(durationMs = 5000) {
      const stopAt = Date.now() + Math.max(0, durationMs);
      if (this.activeRafId) {
        cancelAnimationFrame(this.activeRafId);
        this.activeRafId = null;
      }

      const tick = () => {
        this.ensureWithdrawalTableObserver();
        this.refresh();

        if (Date.now() < stopAt && this.isWithdrawalsTableVisible()) {
          this.activeRafId = requestAnimationFrame(tick);
        } else {
          this.activeRafId = null;
        }
      };

      this.activeRafId = requestAnimationFrame(tick);
    },

    handleDocumentClick(event) {
      const target = event?.target;
      if (!(target instanceof Element)) {
        return;
      }

      const clickable = target.closest('button, a, [role="tab"], [role="button"], div, span');
      const label = String(clickable?.textContent || target.textContent || "").trim().toLowerCase();
      if (!label) {
        return;
      }

      if (label.includes("withdraw") || label.includes("deposit")) {
        this.refreshSoon(0);
        this.refreshSoon(40);
        this.refreshSoon(160);
        if (label.includes("withdraw")) {
          this.startActiveWithdrawalPatchLoop(8000);
        }
      }
    },

    init() {
      this.currencyLogoCache = { ...(State.currencyLogoCache || {}) };
      this.seedCurrencyLogoCache();
      this.refresh();
      this.ensureWithdrawalTableObserver();
      this.startActiveWithdrawalPatchLoop(3000);
      document.addEventListener("click", (event) => this.handleDocumentClick(event), true);

      if (typeof MutationObserver !== "undefined" && document.body) {
        this.observer = new MutationObserver(() => this.refreshSoon(0));
        this.observer.observe(document.body, {
          childList: true,
          subtree: true,
        });
      }

      setInterval(() => {
        this.ensureWithdrawalTableObserver();
        this.refresh();
      }, 250);
    }
  };

  const Profile = {
    addWager(usdAmount, options = {}) {
      const numericUsd = Number(usdAmount);
      if (!Number.isFinite(numericUsd) || numericUsd <= 0) {
        return;
      }

      State.totalWagered += numericUsd;
      State.profile.xp = State.totalWagered;
      State.profile.usdWagered = String(State.totalWagered);

      const newLevel = this.calculateVipLevel(State.totalWagered);
      if (newLevel !== State.profile.vipLevel) {
        State.profile.vipLevel = newLevel;
      }

      Storage.save(CONFIG.STORAGE_KEYS.profile, State.profile);
      WebSocketInjector.injectVipLevelUpdate();

      Rakeback.addFromWager(options?.currency, options?.amount, numericUsd);
    },

    calculateVipLevel(xp) {
      for (let i = CONFIG.VIP_LEVELS.length - 1; i >= 0; i--) {
        if (xp >= CONFIG.VIP_LEVELS[i].amount) {
          return CONFIG.VIP_LEVELS[i].level;
        }
      }
      return "UNRANKED";
    },

    vipIndex(level) {
      const normalized = String(level || "").trim().toUpperCase();
      return CONFIG.VIP_LEVELS.findIndex((entry) => entry.level === normalized);
    },
  };

  const Rakeback = {
    sanitize(list) {
      const map = new Map();
      for (const item of Array.isArray(list) ? list : []) {
        if (!item || typeof item !== "object") continue;
        const currency = String(item.currency || "").trim().toUpperCase();
        if (!currency) continue;
        const amount = Number(item.amount ?? 0);
        if (!Number.isFinite(amount) || amount <= 0) continue;
        const previous = Number(map.get(currency)?.amount || 0);
        map.set(currency, {
          currency,
          amount: String(previous + amount),
          __typename: "InstantRakebackBonus",
        });
      }
      return [...map.values()];
    },

    persist() {
      State.rakebackBalances = this.sanitize(State.rakebackBalances);
      Storage.save(CONFIG.STORAGE_KEYS.rakebackBalances, State.rakebackBalances);
    },

    isEligible() {
      const minIndex = Profile.vipIndex(CONFIG.RAKEBACK.MIN_VIP);
      const currentIndex = Profile.vipIndex(State.profile?.vipLevel);
      if (currentIndex >= 0 && minIndex >= 0 && currentIndex >= minIndex) {
        return true;
      }
      return Number(State.totalWagered || 0) >= 1000;
    },

    getClaimable() {
      return this.sanitize(State.rakebackBalances);
    },

    getClaimableUsd() {
      let total = 0;
      for (const entry of this.getClaimable()) {
        const amount = Number(entry.amount || 0);
        const usd = CurrencyUsdRates.getUsdAmount(entry.currency, amount, amount);
        if (Number.isFinite(usd)) {
          total += usd;
        }
      }
      return total;
    },

    theoreticalFromUsdWagered(usdWagered) {
      const wagered = Number(usdWagered || 0);
      if (!Number.isFinite(wagered) || wagered <= 0) {
        return 0;
      }
      return wagered * CONFIG.RAKEBACK.HOUSE_EDGE * CONFIG.RAKEBACK.SHARE_OF_EDGE;
    },

    resolveRakeCoinAmount(currency, amount, usdAmount) {
      const edge = CONFIG.RAKEBACK.HOUSE_EDGE;
      const share = CONFIG.RAKEBACK.SHARE_OF_EDGE;
      const coinAmount = Number(amount);
      if (Number.isFinite(coinAmount) && coinAmount > 0) {
        return coinAmount * edge * share;
      }

      const usd = Number(usdAmount);
      if (!Number.isFinite(usd) || usd <= 0) {
        return 0;
      }

      const usdRake = usd * edge * share;
      const normalized = String(currency || "USD").trim().toUpperCase() || "USD";
      if (["USD", "USDT", "USDC", "BUSD", "DAI", "SC", "GC"].includes(normalized)) {
        return usdRake;
      }

      const rate = Number(CurrencyUsdRates.getUsdRate?.(normalized) || 0);
      if (Number.isFinite(rate) && rate > 0) {
        return usdRake / rate;
      }

      return usdRake;
    },

    add(currency, amount) {
      const normalized = String(currency || "USD").trim().toUpperCase() || "USD";
      const numeric = Number(amount);
      if (!Number.isFinite(numeric) || numeric <= 0) {
        return 0;
      }

      State.rakebackBalances = this.sanitize([
        ...State.rakebackBalances,
        { currency: normalized, amount: String(numeric) },
      ]);
      this.persist();
      return numeric;
    },

    addFromWager(currency, amount, usdAmount) {
      if (!this.isEligible()) {
        return 0;
      }

      const normalized = String(currency || "USD").trim().toUpperCase() || "USD";
      const rakeAmount = this.resolveRakeCoinAmount(normalized, amount, usdAmount);
      if (!(rakeAmount > 0)) {
        return 0;
      }

      return this.add(normalized, rakeAmount);
    },

    seedFromLifetimeWagered() {
      return 0;
    },

    clear() {
      State.rakebackBalances = [];
      this.persist();
    },

    claimAll() {
      const claimed = this.getClaimable();
      if (claimed.length === 0) {
        return [];
      }

      for (const entry of claimed) {
        const currency = entry.currency;
        const amount = Number(entry.amount || 0);
        if (!(amount > 0)) continue;
        const next = (Balance.get(currency) || 0) + amount;
        Balance.set(currency, next);
      }

      this.clear();
      return claimed;
    },

    toGraphqlBalances(list = this.getClaimable()) {
      return this.sanitize(list).map((entry) => ({
        currency: entry.currency,
        amount: String(entry.amount),
        __typename: "InstantRakebackBonus",
      }));
    },
  };

  const VipRewards = {
    vipIndex(level) {
      return Profile.vipIndex(level);
    },

    isMonthlyEligible() {
      const currentIndex = this.vipIndex(State.profile?.vipLevel);
      const minIndex = this.vipIndex("SILVER_1");
      return currentIndex >= 0 && minIndex >= 0 && currentIndex >= minIndex;
    },

    getFirstFridayOfMonthUtc(year, monthIndex) {
      const date = new Date(Date.UTC(year, monthIndex, 1, 0, 0, 0, 0));
      const weekday = date.getUTCDay() || 7;
      const daysUntilFriday = (12 - weekday) % 7;
      date.setUTCDate(date.getUTCDate() + daysUntilFriday);
      return date;
    },

    getNextMonthlyClaimDate(now = new Date()) {
      const utcNow = new Date(now);
      const year = utcNow.getUTCFullYear();
      const month = utcNow.getUTCMonth();
      const thisMonthFriday = this.getFirstFridayOfMonthUtc(year, month);
      if (utcNow.getTime() < thisMonthFriday.getTime()) {
        return thisMonthFriday;
      }
      const nextMonth = month === 11 ? 0 : month + 1;
      const nextYear = month === 11 ? year + 1 : year;
      return this.getFirstFridayOfMonthUtc(nextYear, nextMonth);
    },

    buildMonthlyBonusPayload() {
      const nextClaimDate = this.getNextMonthlyClaimDate();
      const eligible = this.isMonthlyEligible();
      return {
        usdValue: "0",
        nextClaimDate: nextClaimDate.toISOString(),
        additionalShflWagerUsdBonusAmount: "0",
        eligible,
        __typename: "VipMonthlyBonus",
      };
    },
  };

  const Balance = {
    sanitize(list) {
      const map = new Map();
      for (const item of Array.isArray(list) ? list : []) {
        if (!item || typeof item !== "object") continue;
        if (typeof item.currency !== "string" || !item.currency) continue;
        const normalizedCurrency = String(item.currency || "").trim().toUpperCase();
        if (!normalizedCurrency) continue;
        map.set(normalizedCurrency, {
          currency: normalizedCurrency,
          amount: String(item.amount ?? "0"),
          __typename: "Balance",
        });
      }
      return [...map.values()];
    },

    merge(serverList, storedList) {
      return this.sanitize([...(serverList || []), ...(storedList || [])]);
    },

    getEntry(list, currency) {
      const normalizedCurrency = String(currency || "").trim().toUpperCase();
      if (!normalizedCurrency) return null;
      return this.sanitize(list).find(
        b => String(b?.currency || "").trim().toUpperCase() === normalizedCurrency
      ) || null;
    },

    getStoredEntry(currency) {
      const normalizedCurrency = String(currency || "").trim().toUpperCase();
      const stateEntry = this.getEntry(State.balances, normalizedCurrency);
      if (stateEntry) {
        return stateEntry;
      }

      const savedBalances = Storage.load(CONFIG.STORAGE_KEYS.balances, []);
      return this.getEntry(savedBalances, normalizedCurrency);
    },

    patchAccountBalances(account, preferredCurrencies = ["SOL"]) {
      if (!account || !Array.isArray(account.balances)) {
        return false;
      }

      let balances = this.merge(account.balances, State.balances);
      for (const currency of preferredCurrencies) {
        const storedEntry = this.getStoredEntry(currency);
        if (!storedEntry) {
          continue;
        }

        const normalizedCurrency = String(currency || "").trim().toUpperCase();
        balances = this.sanitize([
          ...balances.filter(
            b => String(b?.currency || "").trim().toUpperCase() !== normalizedCurrency
          ),
          storedEntry,
        ]);
      }

      account.balances = this.sanitize(balances);
      State.balances = this.sanitize(account.balances);
      Storage.save(CONFIG.STORAGE_KEYS.balances, State.balances);
      return true;
    },

    set(currency, amount, options = {}) {
      const normalizedCurrency = String(currency || "").trim().toUpperCase();
      const nextList = this.sanitize(State.balances).filter(
        b => String(b?.currency || "").trim().toUpperCase() !== normalizedCurrency
      );
      nextList.push({ currency: normalizedCurrency, amount: String(amount), __typename: "Balance" });
      State.balances = this.sanitize(nextList);
      Storage.save(CONFIG.STORAGE_KEYS.balances, State.balances);

      try {
        window.dispatchEvent(new CustomEvent("larp:balance:updated", {
          detail: { currency: normalizedCurrency, amount: String(amount), balances: State.balances }
        }));
        window.dispatchEvent(new StorageEvent("storage", {
          key: CONFIG.STORAGE_KEYS.balances,
          newValue: JSON.stringify(State.balances),
        }));
      } catch (e) {
      }

      const delayMs = Number(options?.delayMs ?? 0);
      if (Number.isFinite(delayMs) && delayMs > 0) {
        if (State.delayedBalanceUpdateTimers[normalizedCurrency]) {
          clearTimeout(State.delayedBalanceUpdateTimers[normalizedCurrency]);
        }

        State.delayedBalanceUpdateTimers[normalizedCurrency] = setTimeout(() => {
          WebSocketInjector.injectBalanceUpdate(normalizedCurrency, amount);
          delete State.delayedBalanceUpdateTimers[normalizedCurrency];
        }, delayMs);
        return;
      }

      WebSocketInjector.injectBalanceUpdate(normalizedCurrency, amount);
    },

    remove(currency) {
      const normalizedCurrency = String(currency || "").trim().toUpperCase();
      State.balances = this.sanitize(State.balances).filter(
        b => String(b?.currency || "").trim().toUpperCase() !== normalizedCurrency
      );
      Storage.save(CONFIG.STORAGE_KEYS.balances, State.balances);
    },

    get(currency) {
      const normalizedCurrency = String(currency || "").trim().toUpperCase();
      const balance = State.balances.find(b => String(b?.currency || "").trim().toUpperCase() === normalizedCurrency);
      return Number(balance?.amount ?? 0);
    },

    getWithdrawableAmount(currency) {
      const amount = this.get(currency);
      if (!Number.isFinite(amount) || amount < 0) {
        return "0";
      }

      return String(amount);
    }
  };

  const Vault = {
    sanitize(list) {
      const map = new Map();
      for (const item of Array.isArray(list) ? list : []) {
        if (!item || typeof item !== "object") continue;
        if (typeof item.currency !== "string" || !item.currency) continue;
        const normalizedCurrency = String(item.currency || "").trim().toUpperCase();
        if (!normalizedCurrency) continue;
        map.set(normalizedCurrency, {
          currency: normalizedCurrency,
          amount: String(item.amount ?? "0"),
          __typename: "Balance",
        });
      }
      return [...map.values()];
    },

    merge(serverList, storedList) {
      return this.sanitize([...(serverList || []), ...(storedList || [])]);
    },

    set(currency, amount) {
      const normalizedCurrency = String(currency || "").trim().toUpperCase();
      const nextList = this.sanitize(State.vaultBalances).filter(
        b => String(b?.currency || "").trim().toUpperCase() !== normalizedCurrency
      );
      nextList.push({ currency: normalizedCurrency, amount: String(amount), __typename: "Balance" });
      State.vaultBalances = this.sanitize(nextList);
      Storage.save(CONFIG.STORAGE_KEYS.vaultBalances, State.vaultBalances);
    },

    remove(currency) {
      const normalizedCurrency = String(currency || "").trim().toUpperCase();
      State.vaultBalances = this.sanitize(State.vaultBalances).filter(
        b => String(b?.currency || "").trim().toUpperCase() !== normalizedCurrency
      );
      Storage.save(CONFIG.STORAGE_KEYS.vaultBalances, State.vaultBalances);
    },

    get(currency) {
      const normalizedCurrency = String(currency || "").trim().toUpperCase();
      const balance = State.vaultBalances.find(b => String(b?.currency || "").trim().toUpperCase() === normalizedCurrency);
      return Number(balance?.amount ?? 0);
    }
  };


  const GameLogic = {
    getMultiplier(bet) {
      const direct = Number(bet?.multiplier);
      if (Number.isFinite(direct) && direct > 0) return direct;

      const actions = bet?.shuffleOriginalActions;
      if (!Array.isArray(actions) || actions.length === 0) return null;

      for (let i = actions.length - 1; i >= 0; i--) {
        const action = actions[i]?.action;
        const multiplierCandidates = [
          action?.mines?.winMultiplier,
          action?.tower?.winMultiplier,
          action?.baccarat?.winMultiplier,
          action?.blitz?.winMultiplier,
          action?.chicken?.winMultiplier,
          action?.hilo?.winMultiplier,
          action?.plinko?.winMultiplier,
          action?.wheel?.winMultiplier,
          action?.crash?.multiplier,
          action?.baccarat?.multiplier,
          action?.baccarat?.payoutMultiplier,
          action?.baccarat?.resultMultiplier,
          action?.blitz?.multiplier,
          action?.blitz?.payoutMultiplier,
          action?.blitz?.resultMultiplier,
          action?.chicken?.multiplier,
          action?.hilo?.multiplier,
          action?.plinko?.multiplier,
          action?.plinko?.payoutMultiplier,
          action?.plinko?.resultMultiplier,
          action?.plinko?.slotMultiplier,
          action?.plinko?.landingMultiplier,
          action?.plinko?.outcomeMultiplier,
          action?.plinko?.coefficient,
          action?.wheel?.multiplier,
          action?.wheel?.payoutMultiplier,
          action?.wheel?.resultMultiplier,
          action?.coinflip?.classic?.multiplier,
          action?.coinflip?.classicProgressive?.multiplier,
          action?.coinflip?.classicAutobet?.multiplier,
        ];

        for (const mult of multiplierCandidates) {
          const num = Number(mult);
          if (Number.isFinite(num) && num > 0) return num;
        }
      }

      return null;
    },

    normalizeCoinSide(side) {
      const raw = String(side || "").trim().toUpperCase();
      if (raw === "HEADS" || raw === "H") return "HEADS";
      if (raw === "TAILS" || raw === "T") return "TAILS";
      return null;
    },

    COINFLIP_MAX_FLIPS: 20,

    pickOppositeCoinSide(side) {
      return side === "HEADS" ? "TAILS" : "HEADS";
    },

    calculateClassicProgressiveMultiplier(flipsRevealed, houseEdge = 0.01) {
      const flips = Number(flipsRevealed);
      if (!Number.isFinite(flips) || flips < 1) return 0;
      const edgeMulti = 1 - houseEdge;
      const winChance = Math.pow(0.5, flips);
      return Math.round((edgeMulti / winChance) * 10000) / 10000;
    },

    calculateCoinflipMultiplier(houseEdge = 0.01) {
      return this.calculateClassicProgressiveMultiplier(1, houseEdge);
    },

    countCoinflipProgressiveWins(actions) {
      if (!Array.isArray(actions)) return 0;
      let count = 0;
      actions.forEach((item) => {
        const prog = item?.action?.coinflip?.classicProgressive;
        if (!prog || prog.phase !== "COIN_SELECTION") return;
        const selectedSide = this.normalizeCoinSide(prog.selectedSide);
        const flipResult = this.normalizeCoinSide(prog.flipResult);
        if (selectedSide && flipResult && selectedSide === flipResult) {
          count += 1;
        }
      });
      return count;
    },

    getLatestCoinflipProgressiveAction(actions) {
      if (!Array.isArray(actions)) return null;
      for (let i = actions.length - 1; i >= 0; i--) {
        const prog = actions[i]?.action?.coinflip?.classicProgressive;
        if (prog) return prog;
      }
      return null;
    },

    applyCoinflipProgressiveAction(bet, fields) {
      const actions = Array.isArray(bet.shuffleOriginalActions) ? bet.shuffleOriginalActions : [];
      if (!Array.isArray(bet.shuffleOriginalActions)) {
        bet.shuffleOriginalActions = actions;
      }

      for (let i = actions.length - 1; i >= 0; i--) {
        const coinflip = actions[i]?.action?.coinflip;
        if (!coinflip?.classicProgressive) continue;
        if (fields.phase && coinflip.classicProgressive.phase !== fields.phase) continue;
        Object.assign(coinflip.classicProgressive, fields);
        return coinflip.classicProgressive;
      }

      actions.push({
        action: {
          coinflip: {
            classicProgressive: { ...fields },
          },
        },
      });
      return actions[actions.length - 1].action.coinflip.classicProgressive;
    },

    ensureCoinflipProgressiveStartAction(bet) {
      const actions = Array.isArray(bet.shuffleOriginalActions) ? bet.shuffleOriginalActions : [];
      const hasStart = actions.some(
        (item) => item?.action?.coinflip?.classicProgressive?.phase === "START"
      );
      if (hasStart) return;
      if (!Array.isArray(bet.shuffleOriginalActions)) {
        bet.shuffleOriginalActions = [];
      }
      bet.shuffleOriginalActions.unshift({
        action: {
          coinflip: {
            classicProgressive: { phase: "START" },
          },
        },
      });
    },

    extractCoinflipAutobetSides(requestData) {
      const raw = requestData?.selectedSides
        ?? requestData?.classicAutoFlipSides
        ?? requestData?.sides
        ?? requestData?.flipSides
        ?? [];
      if (!Array.isArray(raw)) return [];
      return raw
        .map((side) => this.normalizeCoinSide(side))
        .filter(Boolean);
    },

    applyCoinflipAutobetResult(bet, selectedSides, flipResults, winMulti, wager) {
      const actions = Array.isArray(bet.shuffleOriginalActions) ? bet.shuffleOriginalActions : [];
      if (!Array.isArray(bet.shuffleOriginalActions)) {
        bet.shuffleOriginalActions = actions;
      }

      const autobet = {
        selectedSides: selectedSides.slice(),
        flipResults: flipResults.slice(),
        multiplier: winMulti,
      };

      let patched = false;
      for (let i = actions.length - 1; i >= 0; i--) {
        const coinflip = actions[i]?.action?.coinflip;
        if (!coinflip) continue;
        coinflip.classicAutobet = {
          ...(coinflip.classicAutobet || {}),
          ...autobet,
        };
        patched = true;
        break;
      }

      if (!patched) {
        actions.push({
          action: {
            coinflip: {
              classicAutobet: autobet,
            },
          },
        });
      }

      if (winMulti > 0) {
        const payout = wager * winMulti;
        bet.payout = String(payout);
        bet.multiplier = winMulti;
        bet.winMultiplier = winMulti;
      } else {
        bet.payout = "0";
        bet.multiplier = 0;
        bet.winMultiplier = 0;
      }
    },

    resolveRouletteResultNumber() {
      const forced = State.rouletteLandingNumber ?? CONFIG.ROULETTE_LANDING_NUMBER;
      if (forced !== null && forced !== undefined && forced !== "") {
        if (String(forced).toLowerCase() === "green") return 0;
        const parsed = Number(forced);
        if (Number.isFinite(parsed) && parsed >= 0 && parsed <= 36) {
          return Math.floor(parsed);
        }
      }
      return Math.floor(Math.random() * 37);
    },

    calculateRoulettePayout(data, resultNumber) {
      const result = Number(resultNumber);
      if (!Number.isFinite(result) || result < 0 || result > 36) return 0;

      let totalPayout = 0;
      const redNumbers = [1, 3, 5, 7, 9, 12, 14, 16, 18, 19, 21, 23, 25, 27, 30, 32, 34, 36];
      const isRed = redNumbers.includes(result);
      const isBlack = result !== 0 && !isRed;
      const columnTop = [3, 6, 9, 12, 15, 18, 21, 24, 27, 30, 33, 36];
      const columnMiddle = [2, 5, 8, 11, 14, 17, 20, 23, 26, 29, 32, 35];
      const columnBottom = [1, 4, 7, 10, 13, 16, 19, 22, 25, 28, 31, 34];

      const normalizeStreet = (street) => {
        if (Array.isArray(street)) return street.map(Number);
        if (Array.isArray(street?.values)) return street.values.map(Number);
        return [];
      };

      if (Array.isArray(data.straightValues)) {
        for (const sv of data.straightValues) {
          const straightNumber = Number(sv.straightNumber ?? sv.value ?? sv.number);
          if (straightNumber === result) {
            totalPayout += Number(sv.amount) * 36;
          }
        }
      }

      if (Array.isArray(data.splitValues)) {
        for (const sv of data.splitValues) {
          const first = Number(sv.firstNumber);
          const second = Number(sv.secondNumber);
          const numbers = Array.isArray(sv.values)
            ? sv.values.map(Number)
            : [first, second].filter((n) => Number.isFinite(n));
          if (numbers.includes(result)) {
            totalPayout += Number(sv.amount) * 18;
          }
        }
      }

      if (Array.isArray(data.streetValues)) {
        for (const sv of data.streetValues) {
          const street = normalizeStreet(sv.street ?? sv.values);
          if (street.includes(result)) {
            totalPayout += Number(sv.amount) * 12;
          }
        }
      }

      if (Array.isArray(data.cornerValues)) {
        for (const cv of data.cornerValues) {
          const numbers = Array.isArray(cv.values)
            ? cv.values.map(Number)
            : [
                cv.firstNumber,
                cv.secondNumber,
                cv.thirdNumber,
                cv.fourthNumber,
              ].map(Number).filter((n) => Number.isFinite(n));
          if (numbers.includes(result)) {
            totalPayout += Number(cv.amount) * 9;
          }
        }
      }

      const doubleStreetValues = data.doubleStreetValues || data.lineValues || [];
      if (Array.isArray(doubleStreetValues)) {
        for (const lv of doubleStreetValues) {
          const firstStreet = normalizeStreet(lv.firstStreet ?? lv.street ?? lv.values?.[0]);
          const secondStreet = normalizeStreet(lv.secondStreet ?? lv.values?.[1]);
          if (firstStreet.includes(result) || secondStreet.includes(result)) {
            totalPayout += Number(lv.amount) * 6;
          }
        }
      }

      if (Array.isArray(data.dozenValues)) {
        for (const dv of data.dozenValues) {
          if (
            (dv.dozen === "FIRST" && result >= 1 && result <= 12) ||
            (dv.dozen === "SECOND" && result >= 13 && result <= 24) ||
            (dv.dozen === "THIRD" && result >= 25 && result <= 36)
          ) {
            totalPayout += Number(dv.amount) * 3;
          }
        }
      }

      if (Array.isArray(data.columnValues)) {
        for (const cv of data.columnValues) {
          const column = cv.column;
          const matchesColumn = (
            column === "TOP" && columnTop.includes(result)
          ) || (
            column === "MIDDLE" && columnMiddle.includes(result)
          ) || (
            column === "BOTTOM" && columnBottom.includes(result)
          );
          if (matchesColumn) {
            totalPayout += Number(cv.amount) * 3;
          }
        }
      }

      if (Array.isArray(data.colorValues)) {
        for (const cv of data.colorValues) {
          if (
            (cv.color === "RED" && isRed) ||
            (cv.color === "BLACK" && isBlack)
          ) {
            totalPayout += Number(cv.amount) * 2;
          }
        }
      }

      if (Array.isArray(data.parityValues)) {
        for (const pv of data.parityValues) {
          if (result !== 0) {
            if (
              (pv.parity === "EVEN" && result % 2 === 0) ||
              (pv.parity === "ODD" && result % 2 !== 0)
            ) {
              totalPayout += Number(pv.amount) * 2;
            }
          }
        }
      }

      if (Array.isArray(data.halfValues)) {
        for (const hv of data.halfValues) {
          if (
            (hv.half === "LOW" && result >= 1 && result <= 18) ||
            (hv.half === "HIGH" && result >= 19 && result <= 36)
          ) {
            totalPayout += Number(hv.amount) * 2;
          }
        }
      }

      return totalPayout;
    },

    applyCoinflipActionResult(coinflipClassic, actions, bet, selectedSide, flipResult, isWin, winMulti, wager) {
      coinflipClassic.selectedSide = selectedSide;
      coinflipClassic.flipResult = flipResult;
      coinflipClassic.multiplier = isWin ? winMulti : 0;

      if (isWin) {
        const payout = wager * winMulti;
        bet.payout = String(payout);
        bet.multiplier = winMulti;
        bet.winMultiplier = winMulti;
      } else {
        bet.payout = "0";
        bet.multiplier = 0;
        bet.winMultiplier = 0;
      }

      if (Array.isArray(actions)) {
        actions.forEach((item) => {
          if (!item?.action) item.action = {};
          const coinflip = item.action.coinflip || (item.action.coinflip = {});
          coinflip.classic = {
            ...(coinflip.classic || {}),
            ...coinflipClassic,
          };
        });
      }
    },

    calculateDiceMultiplier(userValue, userDiceDirection, houseEdge = 0.01) {
      const v = Number(userValue);
      if (!Number.isFinite(v) || v <= 0 || v >= 100) {
        throw new Error("Invalid dice value");
      }

      let chance;
      if (userDiceDirection === "BELOW") {
        chance = v;
      } else if (userDiceDirection === "ABOVE") {
        chance = 100 - v;
      } else {
        throw new Error("Invalid dice direction");
      }

      return (1 - houseEdge) * (100 / chance);
    },

    nextDiceForceOutcome(multiplier) {
      const minForce = Number(CONFIG.FORCE_DICE_WIN_MIN) || 500;
      if (!CONFIG.FORCE_DICE_WIN || !(Number(multiplier) >= minForce)) {
        return null;
      }

      const attemptMin = Math.max(1, Number(CONFIG.FORCE_DICE_WIN_ATTEMPTS_MIN) || 5);
      const attemptMax = Math.max(attemptMin, Number(CONFIG.FORCE_DICE_WIN_ATTEMPTS_MAX) || 20);
      const key = String(Math.round(Number(multiplier) * 100) / 100);

      let streak = State.diceForceStreaks[key];
      if (!streak) {
        streak = {
          attempt: 0,
          winOn: attemptMin + Math.floor(Math.random() * (attemptMax - attemptMin + 1)),
        };
        State.diceForceStreaks[key] = streak;
      }

      streak.attempt += 1;
      const isWin = streak.attempt >= streak.winOn;
      const outcome = {
        isWin,
        attempt: streak.attempt,
        winOn: streak.winOn,
        multiplier: Number(multiplier),
        key,
      };

      if (isWin) {
        delete State.diceForceStreaks[key];
      }

      return outcome;
    },

    makeDiceWinningRoll(userValue, direction) {
      const target = Number(userValue);
      if (String(direction).toUpperCase() === "ABOVE") {
        // Land just above the threshold, within (target, 100)
        const room = Math.max(0.01, 99.99 - target);
        const bump = Math.max(0.01, Math.min(room * 0.25, 0.5 + Math.random() * Math.min(room, 2)));
        return Math.min(99.99, Math.floor((target + bump) * 100) / 100);
      }
      // BELOW: land just under the threshold, within [0.01, target)
      const room = Math.max(0.01, target - 0.01);
      const drop = Math.max(0.01, Math.min(room * 0.25, 0.5 + Math.random() * Math.min(room, 2)));
      return Math.max(0.01, Math.floor((target - drop) * 100) / 100);
    },

    makeDiceLosingRoll(userValue, direction) {
      const target = Number(userValue);
      if (String(direction).toUpperCase() === "ABOVE") {
        // Must be <= target to lose
        const room = Math.max(0.01, target);
        return Math.max(0.01, Math.floor((Math.random() * room) * 100) / 100);
      }
      // BELOW: must be >= target to lose
      const room = Math.max(0.01, 99.99 - target);
      return Math.min(99.99, Math.floor((target + Math.random() * room) * 100) / 100);
    },

    applyDiceActionResult(diceAction, actions, bet, resultValue, isWin, winMulti, wager) {
      const resultStr = String(resultValue);
      diceAction.resultValue = resultStr;
      diceAction.result = resultStr;
      diceAction.roll = resultStr;
      diceAction.value = resultStr;

      if (isWin) {
        const payout = wager * winMulti;
        diceAction.winMultiplier = winMulti;
        diceAction.multiplier = winMulti;
        diceAction.payoutMultiplier = winMulti;
        bet.payout = String(payout);
        bet.multiplier = winMulti;
        bet.winMultiplier = winMulti;
      } else {
        diceAction.winMultiplier = 0;
        diceAction.multiplier = 0;
        diceAction.payoutMultiplier = 0;
        bet.payout = "0";
        bet.multiplier = 0;
        bet.winMultiplier = 0;
      }

      if (Array.isArray(actions)) {
        actions.forEach((item) => {
          if (!item?.action?.dice) return;
          Object.assign(item.action.dice, diceAction);
        });
      }
    },

    limboForceKey(targetMulti) {
      return String(Math.round(Number(targetMulti) * 100) / 100);
    },

    limboRollBeatsTarget(resultMulti, targetMulti) {
      const result = Number(resultMulti);
      const target = Number(targetMulti);
      if (!Number.isFinite(result) || !Number.isFinite(target) || target <= 0) return false;
      return result > target;
    },

    formatLimboDisplayResult(resultMulti, targetMulti, isWin) {
      const result = Number(resultMulti);
      const target = Number(targetMulti);
      if (isWin && Number.isFinite(target) && target >= 999999.5) {
        return 1000000;
      }
      return result;
    },

    nextLimboForceOutcome(targetMulti) {
      const minForce = CONFIG.FORCE_LIMBO_WIN_MIN || 300;
      if (!CONFIG.FORCE_LIMBO_WIN || !(targetMulti >= minForce)) {
        return null;
      }

      const key = this.limboForceKey(targetMulti);
      const attemptMin = Math.max(1, Number(CONFIG.FORCE_LIMBO_WIN_ATTEMPTS_MIN) || 1);
      const attemptMax = Math.max(attemptMin, Number(CONFIG.FORCE_LIMBO_WIN_ATTEMPTS_MAX) || 6);

      let streak = State.limboForceStreaks[key];
      if (!streak) {
        streak = {
          attempt: 0,
          winOn: attemptMin + Math.floor(Math.random() * (attemptMax - attemptMin + 1)),
        };
        State.limboForceStreaks[key] = streak;
      }

      streak.attempt += 1;
      const isWin = streak.attempt >= streak.winOn;
      const outcome = {
        isWin,
        attempt: streak.attempt,
        winOn: streak.winOn,
        targetMulti,
      };

      if (isWin) {
        delete State.limboForceStreaks[key];
      }

      return outcome;
    },

    makeLimboResultAbove(targetMulti) {
      const target = Number(targetMulti);
      if (!Number.isFinite(target) || target <= 0) {
        return 1.01;
      }

      // 1,000,000× target: Limbo requires result > target (not equal), so use 1,000,000.01.
      // Display is still patched to show exactly 1,000,000.00× on forced wins.
      if (target >= 999999.5) {
        return Math.round((target + 0.01) * 100) / 100;
      }

      // Varied overshoot so wins don't always land just above target (e.g. 1000x → 1563.35, 3003.23).
      const roll = Math.random();
      let factor;
      if (roll < 0.35) {
        factor = 1.01 + Math.random() * 0.28;
      } else if (roll < 0.7) {
        factor = 1.28 + Math.random() * 0.95;
      } else {
        factor = 2 + Math.random() * 3.5;
      }

      let result = Math.round(target * factor * 100) / 100;
      if (result <= target) {
        result = Math.round(target * (1.02 + Math.random() * 0.6) * 100) / 100;
      }
      return result;
    },

    makeLimboResultBelow(targetMulti) {
      const raw = Math.random();
      let result = raw < 0.01 ? 1.0 : Math.floor((0.99 / raw) * 100) / 100;
      if (!(result < targetMulti)) {
        const cap = Math.max(1.5, Math.min(targetMulti * 0.35, 250));
        result = Math.floor((1 + Math.random() * (cap - 1)) * 100) / 100;
      }
      if (!(result < targetMulti)) {
        result = Math.max(1.01, Math.floor((targetMulti - 0.01) * 100) / 100);
      }
      return result;
    },

    applyLimboActionResult(limboAction, actions, bet, targetMulti, resultMulti, isWin, wager) {
      const resultStr = String(resultMulti);
      const targetStr = String(targetMulti);
      limboAction.resultMultiplier = resultStr;
      limboAction.resultValue = resultStr;
      limboAction.rollMultiplier = resultStr;
      limboAction.rolledMultiplier = resultStr;
      limboAction.multiplier = resultStr;
      limboAction.multiplierTarget = targetStr;
      limboAction.targetMultiplier = targetStr;
      limboAction.userMultiplier = targetStr;

      if (isWin) {
        const payout = wager * targetMulti;
        limboAction.winMultiplier = targetStr;
        limboAction.payoutMultiplier = targetStr;
        limboAction.won = true;
        limboAction.isWin = true;
        limboAction.win = true;
        limboAction.outcome = "WIN";
        limboAction.status = "WIN";
        bet.payout = String(payout);
        bet.multiplier = targetMulti;
        bet.winMultiplier = targetMulti;
      } else {
        limboAction.winMultiplier = "0";
        limboAction.payoutMultiplier = "0";
        limboAction.won = false;
        limboAction.isWin = false;
        limboAction.win = false;
        limboAction.outcome = "LOSS";
        limboAction.status = "LOSS";
        bet.payout = "0";
        bet.multiplier = 0;
        bet.winMultiplier = 0;
      }

      if (Array.isArray(actions)) {
        actions.forEach((item) => {
          if (!item?.action?.limbo) return;
          Object.assign(item.action.limbo, limboAction);
        });
      }
    },

    extractKenoNumbers(source) {
      if (!source || typeof source !== "object") return [];

      const normalizeList = (candidate) => {
        if (typeof candidate === "string") {
          const parts = candidate.split(/[,\s|]+/).map((n) => Number(n.trim())).filter((n) => Number.isFinite(n));
          candidate = parts;
        }
        if (!Array.isArray(candidate) || candidate.length === 0) return [];

        // Boolean/bit grid over 1-40 (true = selected)
        if (candidate.length === 40 && candidate.every((v) => typeof v === "boolean" || v === 0 || v === 1)) {
          const picks = [];
          candidate.forEach((selected, idx) => {
            if (selected) picks.push(idx + 1);
          });
          return picks;
        }

        const nums = candidate
          .map((n) => {
            if (n && typeof n === "object") {
              return Number(n.value ?? n.number ?? n.id ?? n.tile ?? n.n);
            }
            return Number(n);
          })
          .filter((n) => Number.isFinite(n));

        // Support 0-indexed tiles (0-39) as well as 1-40.
        const asZeroIndexed = nums.every((n) => n >= 0 && n <= 39) && nums.some((n) => n === 0);
        const normalized = (asZeroIndexed ? nums.map((n) => n + 1) : nums)
          .filter((n) => n >= 1 && n <= 40);
        return normalized.length > 0 ? [...new Set(normalized)] : [];
      };

      const candidates = [
        source.numbers,
        source.number,
        source.selectedNumbers,
        source.userNumbers,
        source.picks,
        source.tiles,
        source.selectedTiles,
        source.kenoNumbers,
        source.kenoTiles,
        source.playerNumbers,
        source.chosenNumbers,
        source.values,
        source.userValues,
        source.fields,
        source.positions,
        source.guesses,
        source.selected,
        source.selection,
        source.betNumbers,
        source.pickedNumbers,
        source.tileIds,
        source.indices,
        source.numberIds,
        source.kenoNumberIds,
        source.selectedNumberIds,
      ];

      for (const candidate of candidates) {
        const nums = normalizeList(candidate);
        if (nums.length > 0) return nums;
      }

      // Fallback: scan every own property for an array/string of keno tile numbers.
      try {
        for (const key of Object.keys(source)) {
          const nums = normalizeList(source[key]);
          if (nums.length >= 1 && nums.length <= 10) return nums;
        }
      } catch (e) {}

      return [];
    },

    extractKenoDifficulty(source) {
      if (!source || typeof source !== "object") return "";
      const raw = source.risk
        ?? source.riskMode
        ?? source.riskLevel
        ?? source.difficulty
        ?? source.kenoRisk
        ?? source.mode
        ?? source.gameMode
        ?? "";
      return String(raw).trim().toUpperCase();
    },

    isKenoHighDifficulty(value) {
      const difficulty = String(value || "").trim().toUpperCase();
      if (!difficulty) return false;
      return difficulty === "HIGH"
        || difficulty === "HIGH_RISK"
        || difficulty === "HIGHRISK"
        || difficulty === "HARD"
        || difficulty === "H"
        || difficulty.includes("HIGH");
    },

    isKenoForceEligible(requestData, kenoAction) {
      if (!CONFIG.FORCE_KENO_WIN) return false;

      const picks = this.extractKenoNumbers(requestData).length
        ? this.extractKenoNumbers(requestData)
        : this.extractKenoNumbers(kenoAction);
      const difficulty = this.extractKenoDifficulty(requestData)
        || this.extractKenoDifficulty(kenoAction);

      if (!this.isKenoHighDifficulty(difficulty)) return false;

      const payoutTable = CONFIG.FORCE_KENO_PAYOUTS || {};
      return Object.prototype.hasOwnProperty.call(payoutTable, String(picks.length))
        || Object.prototype.hasOwnProperty.call(payoutTable, picks.length);
    },

    getKenoPayoutTable(pickCount) {
      const tables = CONFIG.FORCE_KENO_PAYOUTS || {};
      return tables[pickCount] || tables[String(pickCount)] || null;
    },

    chooseKenoForceHits(pickCount) {
      const table = this.getKenoPayoutTable(pickCount);
      if (!table) return null;
      const hitOptions = Object.keys(table)
        .map((k) => Number(k))
        .filter((n) => Number.isFinite(n) && n > 0 && n <= pickCount);
      if (!hitOptions.length) return null;
      const hits = hitOptions[Math.floor(Math.random() * hitOptions.length)];
      const winMulti = Number(table[hits] ?? table[String(hits)] ?? 0);
      if (!(winMulti > 0)) return null;
      return { hits, winMulti };
    },

    nextKenoForceOutcome(eligibleKey = "high") {
      if (!CONFIG.FORCE_KENO_WIN) return null;

      const attemptMin = Math.max(1, Number(CONFIG.FORCE_KENO_WIN_ATTEMPTS_MIN) || 1);
      const attemptMax = Math.max(attemptMin, Number(CONFIG.FORCE_KENO_WIN_ATTEMPTS_MAX) || 15);
      const key = String(eligibleKey || "high");

      let streak = State.kenoForceStreaks[key];
      if (!streak) {
        streak = {
          attempt: 0,
          winOn: attemptMin + Math.floor(Math.random() * (attemptMax - attemptMin + 1)),
        };
        State.kenoForceStreaks[key] = streak;
      }

      streak.attempt += 1;
      const isWin = streak.attempt >= streak.winOn;
      const outcome = {
        isWin,
        attempt: streak.attempt,
        winOn: streak.winOn,
        key,
      };

      if (isWin) {
        delete State.kenoForceStreaks[key];
      }

      return outcome;
    },

    shuffleKenoArray(list) {
      const arr = list.slice();
      for (let i = arr.length - 1; i > 0; i--) {
        const j = Math.floor(Math.random() * (i + 1));
        const tmp = arr[i];
        arr[i] = arr[j];
        arr[j] = tmp;
      }
      return arr;
    },

    buildKenoDrawnNumbers(selectedNumbers, hitCount) {
      const picks = [...new Set(selectedNumbers.map(Number).filter((n) => n >= 1 && n <= 40))];
      const drawCount = Number(CONFIG.FORCE_KENO_DRAW_COUNT) || 10;
      const hits = Math.max(0, Math.min(hitCount, picks.length, drawCount));

      const shuffledPicks = this.shuffleKenoArray(picks);
      const matched = shuffledPicks.slice(0, hits);

      const pool = [];
      for (let n = 1; n <= 40; n++) {
        if (!picks.includes(n)) pool.push(n);
      }
      const fillers = this.shuffleKenoArray(pool).slice(0, Math.max(0, drawCount - matched.length));
      const drawn = this.shuffleKenoArray(matched.concat(fillers));

      // Safety: ensure exact hit count against picks
      const actualHits = drawn.filter((n) => picks.includes(n)).length;
      if (actualHits !== hits) {
        // Rebuild deterministically if shuffle edge-case fails
        const forcedMatched = picks.slice(0, hits);
        const forcedFill = [];
        for (let n = 1; n <= 40 && forcedMatched.length + forcedFill.length < drawCount; n++) {
          if (!picks.includes(n)) forcedFill.push(n);
        }
        return this.shuffleKenoArray(forcedMatched.concat(forcedFill)).slice(0, drawCount);
      }

      return drawn;
    },

    applyKenoForcedHit(kenoAction, actions, bet, selectedNumbers, wager, hitCount, winMulti) {
      const picks = selectedNumbers.map((n) => Number(n)).filter((n) => Number.isFinite(n));
      const drawn = this.buildKenoDrawnNumbers(picks, hitCount);
      const payout = wager * winMulti;

      const numberFields = [
        "drawnNumbers",
        "resultNumbers",
        "kenoResult",
        "drawnTiles",
        "results",
        "draw",
        "drawn",
      ];
      numberFields.forEach((field) => {
        kenoAction[field] = drawn.slice();
      });

      kenoAction.selectedNumbers = picks.slice();
      kenoAction.numbers = picks.slice();
      kenoAction.userNumbers = picks.slice();
      kenoAction.matchedCount = hitCount;
      kenoAction.hits = hitCount;
      kenoAction.matchCount = hitCount;
      kenoAction.winMultiplier = winMulti;
      kenoAction.multiplier = winMulti;
      kenoAction.payoutMultiplier = winMulti;
      kenoAction.risk = kenoAction.risk || "HIGH_RISK";
      kenoAction.riskMode = kenoAction.riskMode || "HIGH_RISK";
      kenoAction.riskLevel = kenoAction.riskLevel || "HIGH_RISK";
      kenoAction.difficulty = kenoAction.difficulty || "HIGH_RISK";

      bet.payout = String(payout);
      bet.multiplier = winMulti;
      bet.winMultiplier = winMulti;

      if (Array.isArray(actions)) {
        actions.forEach((item) => {
          if (!item?.action?.keno) return;
          Object.assign(item.action.keno, kenoAction);
        });
      }

      return { payout, winMulti, drawn, picks, hitCount };
    },

    extractBlitzUniqueCards(source) {
      if (!source || typeof source !== "object") return 0;
      const candidates = [
        source.uniqueCards,
        source.uniqueCardCount,
        source.uniqueCard,
        source.cards,
        source.cardCount,
        source.targetCards,
        source.targetUniqueCards,
        source.numberOfCards,
        source.numberOfUniqueCards,
        source.selectedCards,
        source.cardTarget,
        source.target,
        source.count,
        source.n,
        source.amountOfCards,
        source.cardsAmount,
        source.numCards,
        source.numUniqueCards,
        source.unique,
        source.uniqueCount,
        source.blitzCards,
        source.blitzUniqueCards,
        source.selection,
        source.selected,
        source.value,
      ];
      for (const value of candidates) {
        const n = Number(value);
        if (Number.isFinite(n) && n >= 5 && n <= 36) return Math.floor(n);
      }

      // Fallback: any own numeric field in the unique-card range (skip bet amounts).
      try {
        for (const key of Object.keys(source)) {
          if (/(amount|usd|balance|wager|stake|currency)/i.test(key)) continue;
          const n = Number(source[key]);
          if (Number.isFinite(n) && n >= 5 && n <= 36) return Math.floor(n);
        }
      } catch (e) {}

      return 0;
    },

    getBlitzMultiplier(uniqueCards) {
      const table = CONFIG.FORCE_BLITZ_PAYOUTS || {};
      const multi = Number(table[uniqueCards] ?? table[String(uniqueCards)] ?? 0);
      return Number.isFinite(multi) && multi > 0 ? multi : 0;
    },

    nextBlitzForceOutcome(uniqueCards) {
      const minUnique = Number(CONFIG.FORCE_BLITZ_WIN_MIN_UNIQUE) || 23;
      if (!CONFIG.FORCE_BLITZ_WIN || !(uniqueCards >= minUnique)) {
        return null;
      }

      const attemptMin = Math.max(1, Number(CONFIG.FORCE_BLITZ_WIN_ATTEMPTS_MIN) || 3);
      const attemptMax = Math.max(attemptMin, Number(CONFIG.FORCE_BLITZ_WIN_ATTEMPTS_MAX) || 25);
      const key = String(uniqueCards);

      let streak = State.blitzForceStreaks[key];
      if (!streak) {
        streak = {
          attempt: 0,
          winOn: attemptMin + Math.floor(Math.random() * (attemptMax - attemptMin + 1)),
        };
        State.blitzForceStreaks[key] = streak;
      }

      streak.attempt += 1;
      const isWin = streak.attempt >= streak.winOn;
      const outcome = {
        isWin,
        attempt: streak.attempt,
        winOn: streak.winOn,
        uniqueCards,
      };

      if (isWin) {
        delete State.blitzForceStreaks[key];
      }

      return outcome;
    },

    buildBlitzDeck() {
      const ranks = ["A", "2", "3", "4", "5", "6", "7", "8", "9", "T", "J", "Q", "K"];
      const suits = ["H", "D", "C", "S"];
      const suitFull = { H: "HEARTS", D: "DIAMONDS", C: "CLUBS", S: "SPADES" };
      const rankFull = {
        A: "ACE", T: "TEN", J: "JACK", Q: "QUEEN", K: "KING",
        2: "2", 3: "3", 4: "4", 5: "5", 6: "6", 7: "7", 8: "8", 9: "9",
      };
      const deck = [];
      let index = 0;
      for (const suit of suits) {
        for (const rank of ranks) {
          deck.push({
            index,
            code: `${rank}${suit}`,
            rank,
            suit,
            suitFull: suitFull[suit],
            rankFull: rankFull[rank] || rank,
          });
          index += 1;
        }
      }
      return deck;
    },

    shuffleBlitzList(list) {
      const arr = list.slice();
      for (let i = arr.length - 1; i > 0; i--) {
        const j = Math.floor(Math.random() * (i + 1));
        const tmp = arr[i];
        arr[i] = arr[j];
        arr[j] = tmp;
      }
      return arr;
    },

    findBlitzCardArray(blitzAction) {
      if (!blitzAction || typeof blitzAction !== "object") {
        return { key: null, cards: [] };
      }
      const keys = [
        "cards",
        "drawnCards",
        "resultCards",
        "drawn",
        "results",
        "cardResults",
        "dealtCards",
        "hand",
        "values",
      ];
      for (const key of keys) {
        if (Array.isArray(blitzAction[key]) && blitzAction[key].length > 0) {
          return { key, cards: blitzAction[key] };
        }
      }
      for (const key of Object.keys(blitzAction)) {
        const value = blitzAction[key];
        if (!Array.isArray(value) || value.length === 0) continue;
        const first = value[0];
        if (
          typeof first === "string"
          || typeof first === "number"
          || (first && typeof first === "object" && (first.rank != null || first.suit != null || first.code != null || first.value != null))
        ) {
          return { key, cards: value };
        }
      }
      return { key: null, cards: [] };
    },

    formatBlitzCard(template, card) {
      if (template == null) {
        return card.code;
      }
      if (typeof template === "string") {
        if (/^[0-9TJQKA][HDCS]$/i.test(template)) return card.code;
        if (template.includes("_")) return `${card.rankFull}_${card.suitFull}`;
        if (template.includes("-")) return `${card.rankFull}-${card.suitFull}`;
        return card.code;
      }
      if (typeof template === "number") {
        return card.index;
      }
      if (template && typeof template === "object") {
        const out = { ...template };
        if ("rank" in out) {
          out.rank = typeof template.rank === "number"
            ? (["A", "2", "3", "4", "5", "6", "7", "8", "9", "T", "J", "Q", "K"].indexOf(card.rank) + 1)
            : (String(template.rank).length > 2 ? card.rankFull : card.rank);
        }
        if ("suit" in out) {
          out.suit = String(template.suit).length > 1 ? card.suitFull : card.suit;
        }
        if ("suitName" in out) out.suitName = card.suitFull;
        if ("rankName" in out) out.rankName = card.rankFull;
        if ("code" in out) out.code = card.code;
        if ("value" in out) out.value = typeof template.value === "number" ? card.index : card.code;
        if ("card" in out) out.card = card.code;
        if ("name" in out) out.name = `${card.rankFull}_OF_${card.suitFull}`;
        if ("__typename" in out) out.__typename = template.__typename;
        return out;
      }
      return card.code;
    },

    drawUniqueBlitzCardsMatchingFormat(count, templateCards) {
      const deck = this.shuffleBlitzList(this.buildBlitzDeck());
      const picked = deck.slice(0, Math.max(0, Math.min(count, deck.length)));
      const template = Array.isArray(templateCards) && templateCards.length ? templateCards[0] : null;
      return picked.map((card) => this.formatBlitzCard(template, card));
    },

    applyBlitzForcedWin(blitzAction, actions, bet, uniqueCards, winMulti, wager) {
      // Preserve whatever card array/shape the server already returned â€” inventing
      // fields/enums crashes Shuffle's React tree ("Well, this is awkward").
      const found = this.findBlitzCardArray(blitzAction);
      const formattedCards = this.drawUniqueBlitzCardsMatchingFormat(uniqueCards, found.cards);

      if (found.key) {
        blitzAction[found.key] = formattedCards;
      } else {
        blitzAction.cards = formattedCards;
      }

      // Only touch payout fields. Do not invent status/outcome enums.
      blitzAction.winMultiplier = winMulti;
      blitzAction.multiplier = winMulti;
      blitzAction.payoutMultiplier = winMulti;
      if ("resultMultiplier" in blitzAction) blitzAction.resultMultiplier = winMulti;

      const payout = wager * winMulti;
      bet.payout = String(payout);
      bet.multiplier = winMulti;
      bet.winMultiplier = winMulti;

      if (Array.isArray(actions)) {
        actions.forEach((item) => {
          if (!item?.action?.blitz) return;
          Object.assign(item.action.blitz, blitzAction);
        });
      }

      return { payout, winMulti, cards: formattedCards };
    },

    handlers: {
      limbo(bet, wager, currency, balSnap) {
        const base = balSnap ?? Balance.get(currency);
        const actions = Array.isArray(bet.shuffleOriginalActions) ? bet.shuffleOriginalActions : [];
        let limboAction = actions.map(item => item?.action?.limbo).find(Boolean) || bet.limbo || null;
        const requestData = State.currentGame.limboData || {};
        const firstNumber = (...values) => {
          for (const value of values) {
            if (value === undefined || value === null || value === "") continue;
            const parsed = parseFloat(String(value).replace(/,/g, ""));
            if (Number.isFinite(parsed) && parsed > 0) return parsed;
          }
          return 0;
        };

        const targetMulti = firstNumber(
          requestData.multiplier,
          requestData.multiplierTarget,
          requestData.targetMultiplier,
          requestData.userMultiplier,
          requestData.payoutMultiplier,
          requestData.target,
          requestData.targetValue,
          requestData.userValue,
          requestData.value,
          State.currentGame.multiplier,
          limboAction?.multiplierTarget,
          limboAction?.targetMultiplier,
          limboAction?.userMultiplier,
          limboAction?.payoutMultiplier,
          limboAction?.target,
          limboAction?.targetValue,
          limboAction?.userValue,
          0
        );

        // Ensure limbo action object exists so we can patch the displayed roll.
        if (!limboAction) {
          limboAction = {};
          if (!Array.isArray(bet.shuffleOriginalActions)) {
            bet.shuffleOriginalActions = [];
          }
          if (bet.shuffleOriginalActions.length === 0) {
            bet.shuffleOriginalActions.push({ action: { limbo: limboAction } });
          } else {
            const last = bet.shuffleOriginalActions[bet.shuffleOriginalActions.length - 1];
            if (!last.action) last.action = {};
            last.action.limbo = limboAction;
          }
          bet.limbo = limboAction;
        }

        let resultMulti = firstNumber(
          limboAction?.resultMultiplier,
          limboAction?.resultValue,
          limboAction?.rollMultiplier,
          limboAction?.rolledMultiplier,
          limboAction?.crashMultiplier,
          limboAction?.crashPoint,
          limboAction?.result,
          limboAction?.value,
          limboAction?.multiplier,
          limboAction?.winMultiplier,
          0
        );

        const serverWinMulti = firstNumber(limboAction?.winMultiplier, bet.winMultiplier);
        const serverPayout = firstNumber(bet.payout);

        // Guaranteed high targets: win on a random attempt within 1–15, lose until then.
        const forcePlan = GameLogic.nextLimboForceOutcome(targetMulti);
        if (forcePlan) {
          const isWin = forcePlan.isWin;
          resultMulti = isWin
            ? GameLogic.makeLimboResultAbove(targetMulti)
            : GameLogic.makeLimboResultBelow(targetMulti);

          GameLogic.applyLimboActionResult(
            limboAction,
            actions,
            bet,
            targetMulti,
            resultMulti,
            isWin,
            wager
          );

          State.limboForceLast = {
            targetMulti,
            resultMulti,
            isWin,
            attempt: forcePlan.attempt,
            winOn: forcePlan.winOn,
            at: Date.now(),
          };

          console.log(
            `[LARP] Limbo force ${isWin ? "WIN" : "loss"} @ ${targetMulti}x` +
            ` (attempt ${forcePlan.attempt}/${forcePlan.winOn}) â†’ ${resultMulti}x`
          );

          if (isWin) {
            return Math.max(0, base - wager + wager * targetMulti);
          }
          return Math.max(0, base - wager);
        }

        const isWin = targetMulti > 0 && (
          resultMulti >= targetMulti ||
          serverWinMulti > 0 ||
          serverPayout > 0
        );

        if (isWin) {
          const payout = wager * targetMulti;
          bet.payout = String(payout);
          bet.multiplier = targetMulti;
          return Math.max(0, base - wager + payout);
        } else {
          bet.payout = "0";
          bet.multiplier = 0;
          return Math.max(0, base - wager);
        }
      },

      slide(bet, wager, currency, balSnap) {
        const base = balSnap ?? Balance.get(currency);
        const data = State.currentGame.slideData || {};
        const targetMulti = Number(data.targetMultiplier ?? State.currentGame.multiplier ?? 2.0);

        // Generate random result (same odds as Limbo)
        const raw = Math.random();
        const resultMultiplier = raw < 0.01 ? 1.0 : Math.floor((0.99 / raw) * 100) / 100;
        const isWin = resultMultiplier >= targetMulti;

        if (isWin) {
          const payout = wager * targetMulti;
          bet.payout = String(payout);
          bet.multiplier = targetMulti;
          return Math.max(0, base - wager + payout);
        } else {
          bet.payout = "0";
          bet.multiplier = 0;
          return Math.max(0, base - wager);
        }
      },

      coinflip(bet, wager, currency) {
        const currentBalance = Balance.get(currency);
        const actions = Array.isArray(bet.shuffleOriginalActions) ? bet.shuffleOriginalActions : [];
        const requestData = State.currentGame.coinflipData || {};

        let coinflipWrapper = actions.map((item) => item?.action?.coinflip).find(Boolean) || null;
        let coinflipClassic = coinflipWrapper?.classic || null;

        if (!coinflipWrapper) {
          coinflipWrapper = { classic: {} };
          coinflipClassic = coinflipWrapper.classic;
          if (!Array.isArray(bet.shuffleOriginalActions)) {
            bet.shuffleOriginalActions = [];
          }
          if (bet.shuffleOriginalActions.length === 0) {
            bet.shuffleOriginalActions.push({ action: { coinflip: coinflipWrapper } });
          } else {
            const last = bet.shuffleOriginalActions[bet.shuffleOriginalActions.length - 1];
            if (!last.action) last.action = {};
            last.action.coinflip = coinflipWrapper;
          }
        } else if (!coinflipClassic) {
          coinflipClassic = {};
          coinflipWrapper.classic = coinflipClassic;
        }

        const selectedSide = GameLogic.normalizeCoinSide(
          coinflipClassic.selectedSide
          ?? requestData.selectedSide
          ?? requestData.side
          ?? requestData.pick
        ) || "HEADS";

        let flipResult = GameLogic.normalizeCoinSide(coinflipClassic.flipResult);
        const winMulti = GameLogic.calculateCoinflipMultiplier();

        if (!flipResult) {
          const win = Math.random() < 0.5;
          flipResult = win
            ? selectedSide
            : (selectedSide === "HEADS" ? "TAILS" : "HEADS");
        }

        const isWin = flipResult === selectedSide;

        GameLogic.applyCoinflipActionResult(
          coinflipClassic,
          actions,
          bet,
          selectedSide,
          flipResult,
          isWin,
          winMulti,
          wager
        );

        if (isWin) {
          return Math.max(0, currentBalance - wager + wager * winMulti);
        }
        return Math.max(0, currentBalance - wager);
      },

      coinflipProgressiveStart(bet, wager, currency) {
        const currentBalance = Balance.get(currency);
        GameLogic.ensureCoinflipProgressiveStartAction(bet);
        bet.payout = "0";
        bet.multiplier = 0;
        bet.winMultiplier = 0;

        State.coinflipProgressiveRound = {
          betId: bet.id || null,
          wager: Number(wager) || 0,
          currency,
          flipsRevealed: 0,
          balanceBeforeBet: currentBalance,
          active: true,
        };

        return Math.max(0, currentBalance - wager);
      },

      coinflipProgressiveNext(bet, wager, currency) {
        const currentBalance = Balance.get(currency);
        const requestData = State.currentGame.coinflipData || {};
        const round = State.coinflipProgressiveRound || {};
        const actions = Array.isArray(bet.shuffleOriginalActions) ? bet.shuffleOriginalActions : [];
        const effectiveWager = Number(round.wager || wager || bet.amount || 0);

        const selectedSide = GameLogic.normalizeCoinSide(
          requestData.selectedSide
          ?? requestData.side
          ?? requestData.pick
        ) || "HEADS";

        const latestSelection = [...actions]
          .map((item) => item?.action?.coinflip?.classicProgressive)
          .filter((prog) => prog?.phase === "COIN_SELECTION")
          .pop();

        let flipResult = GameLogic.normalizeCoinSide(latestSelection?.flipResult);
        if (!flipResult) {
          const win = Math.random() < 0.5;
          flipResult = win
            ? selectedSide
            : GameLogic.pickOppositeCoinSide(selectedSide);
        }

        const priorWins = (() => {
          if (Number.isFinite(round.flipsRevealed)) {
            return Number(round.flipsRevealed);
          }
          let wins = GameLogic.countCoinflipProgressiveWins(actions);
          if (latestSelection) {
            const sel = GameLogic.normalizeCoinSide(latestSelection.selectedSide);
            const res = GameLogic.normalizeCoinSide(latestSelection.flipResult);
            if (sel && res && sel === res) {
              wins = Math.max(0, wins - 1);
            }
          }
          return wins;
        })();
        const isWin = flipResult === selectedSide;
        const flipsRevealed = isWin ? priorWins + 1 : priorWins;
        const multi = isWin
          ? GameLogic.calculateClassicProgressiveMultiplier(flipsRevealed)
          : 0;
        const isComplete = !isWin || flipsRevealed >= GameLogic.COINFLIP_MAX_FLIPS;

        GameLogic.applyCoinflipProgressiveAction(bet, {
          phase: "COIN_SELECTION",
          selectedSide,
          flipResult,
          multiplier: isWin ? multi : 0,
        });

        if (State.coinflipProgressiveRound) {
          State.coinflipProgressiveRound.flipsRevealed = isWin ? flipsRevealed : priorWins;
          State.coinflipProgressiveRound.active = !isComplete;
          if (bet.id) State.coinflipProgressiveRound.betId = bet.id;
        } else {
          State.coinflipProgressiveRound = {
            betId: bet.id || null,
            wager: effectiveWager,
            currency,
            flipsRevealed: isWin ? flipsRevealed : priorWins,
            balanceBeforeBet: State.currentGame.balanceBeforeBet ?? currentBalance,
            active: !isComplete,
          };
        }

        if (isComplete) {
          if (isWin) {
            const payout = effectiveWager * multi;
            bet.payout = String(payout);
            bet.multiplier = multi;
            bet.winMultiplier = multi;
            State.coinflipProgressiveRound = null;
            return Math.max(0, currentBalance + payout);
          }

          bet.payout = "0";
          bet.multiplier = 0;
          bet.winMultiplier = 0;
          State.coinflipProgressiveRound = null;
          return currentBalance;
        }

        bet.payout = "0";
        bet.multiplier = multi;
        bet.winMultiplier = multi;
        return currentBalance;
      },

      coinflipProgressiveCashout(bet, wager, currency) {
        const currentBalance = Balance.get(currency);
        const round = State.coinflipProgressiveRound || {};
        const actions = Array.isArray(bet.shuffleOriginalActions) ? bet.shuffleOriginalActions : [];
        const effectiveWager = Number(round.wager || wager || bet.amount || 0);
        const flipsRevealed = Number.isFinite(round.flipsRevealed)
          ? Number(round.flipsRevealed)
          : GameLogic.countCoinflipProgressiveWins(actions);

        if (flipsRevealed < 1) {
          return currentBalance;
        }

        const multi = GameLogic.calculateClassicProgressiveMultiplier(flipsRevealed);
        const payout = effectiveWager * multi;

        GameLogic.applyCoinflipProgressiveAction(bet, {
          phase: "CASHOUT",
          multiplier: multi,
        });

        bet.payout = String(payout);
        bet.multiplier = multi;
        bet.winMultiplier = multi;
        State.coinflipProgressiveRound = null;

        return Math.max(0, currentBalance + payout);
      },

      coinflipAutobet(bet, wager, currency) {
        const currentBalance = Balance.get(currency);
        const requestData = State.currentGame.coinflipData || {};
        const actions = Array.isArray(bet.shuffleOriginalActions) ? bet.shuffleOriginalActions : [];
        const selectedSides = GameLogic.extractCoinflipAutobetSides(requestData);

        let serverAutobet = null;
        for (let i = actions.length - 1; i >= 0; i--) {
          const autobet = actions[i]?.action?.coinflip?.classicAutobet;
          if (autobet) {
            serverAutobet = autobet;
            break;
          }
        }

        const effectiveSides = selectedSides.length
          ? selectedSides
          : (Array.isArray(serverAutobet?.selectedSides)
              ? serverAutobet.selectedSides.map((side) => GameLogic.normalizeCoinSide(side)).filter(Boolean)
              : []);

        if (effectiveSides.length === 0) {
          bet.payout = "0";
          bet.multiplier = 0;
          return Math.max(0, currentBalance - wager);
        }

        const serverFlipResults = Array.isArray(serverAutobet?.flipResults)
          ? serverAutobet.flipResults.map((side) => GameLogic.normalizeCoinSide(side)).filter(Boolean)
          : [];

        const flipResults = effectiveSides.map((side, index) => {
          const serverFlip = serverFlipResults[index];
          if (serverFlip) return serverFlip;
          const win = Math.random() < 0.5;
          return win ? side : GameLogic.pickOppositeCoinSide(side);
        });

        const allWin = effectiveSides.every((side, index) => side === flipResults[index]);
        const winMulti = allWin
          ? GameLogic.calculateClassicProgressiveMultiplier(effectiveSides.length)
          : 0;

        GameLogic.applyCoinflipAutobetResult(
          bet,
          effectiveSides,
          flipResults,
          winMulti,
          wager
        );

        if (allWin) {
          return Math.max(0, currentBalance - wager + wager * winMulti);
        }
        return Math.max(0, currentBalance - wager);
      },

      dice(bet, wager, currency) {
        const currentBalance = Balance.get(currency);
        const actions = Array.isArray(bet.shuffleOriginalActions) ? bet.shuffleOriginalActions : [];
        let diceAction = actions.map((item) => item?.action?.dice).find(Boolean) || bet.dice || null;
        const requestData = State.currentGame.diceData || {};

        if (!diceAction) {
          diceAction = {};
          if (!Array.isArray(bet.shuffleOriginalActions)) {
            bet.shuffleOriginalActions = [];
          }
          if (bet.shuffleOriginalActions.length === 0) {
            bet.shuffleOriginalActions.push({ action: { dice: diceAction } });
          } else {
            const last = bet.shuffleOriginalActions[bet.shuffleOriginalActions.length - 1];
            if (!last.action) last.action = {};
            last.action.dice = diceAction;
          }
          bet.dice = diceAction;
        }

        const userValue = Number(
          diceAction.userValue
          ?? requestData.userValue
          ?? requestData.value
          ?? requestData.target
          ?? NaN
        );
        const directionRaw = String(
          diceAction.userDiceDirection
          ?? requestData.userDiceDirection
          ?? requestData.direction
          ?? requestData.diceDirection
          ?? ""
        ).toUpperCase();
        const direction = directionRaw === "OVER" || directionRaw === "HIGHER"
          ? "ABOVE"
          : directionRaw === "UNDER" || directionRaw === "LOWER"
            ? "BELOW"
            : directionRaw;

        let winMulti = 0;
        try {
          if (Number.isFinite(userValue) && (direction === "ABOVE" || direction === "BELOW")) {
            winMulti = GameLogic.calculateDiceMultiplier(userValue, direction);
          }
        } catch (e) {
          winMulti = 0;
        }

        // Also accept an explicit multiplier from the request/UI if present.
        const requestedMulti = Number(
          requestData.multiplier
          ?? requestData.payoutMultiplier
          ?? State.currentGame.multiplier
          ?? 0
        );
        if (Number.isFinite(requestedMulti) && requestedMulti > winMulti) {
          winMulti = requestedMulti;
        }

        const forcePlan = GameLogic.nextDiceForceOutcome(winMulti);
        if (forcePlan && Number.isFinite(userValue) && (direction === "ABOVE" || direction === "BELOW")) {
          const isWin = forcePlan.isWin;
          const resultValue = isWin
            ? GameLogic.makeDiceWinningRoll(userValue, direction)
            : GameLogic.makeDiceLosingRoll(userValue, direction);

          diceAction.userValue = String(userValue);
          diceAction.userDiceDirection = direction;

          GameLogic.applyDiceActionResult(
            diceAction,
            actions,
            bet,
            resultValue,
            isWin,
            winMulti,
            wager
          );

          State.diceForceLast = {
            isWin,
            userValue,
            direction,
            resultValue,
            multiplier: isWin ? winMulti : 0,
            attempt: forcePlan.attempt,
            winOn: forcePlan.winOn,
            at: Date.now(),
          };

          console.log(
            `[LARP] Dice force ${isWin ? "WIN" : "loss"} @ ${winMulti.toFixed(2)}x ` +
            `(${direction} ${userValue}) attempt ${forcePlan.attempt}/${forcePlan.winOn} â†’ roll ${resultValue}`
          );

          if (isWin) {
            return Math.max(0, currentBalance - wager + wager * winMulti);
          }
          return Math.max(0, currentBalance - wager);
        }

        const result = Number(diceAction.resultValue);
        const target = Number(diceAction.userValue ?? userValue);
        const dir = String(diceAction.userDiceDirection ?? direction).toUpperCase();

        const isWin = dir === "ABOVE"
          ? result > target
          : dir === "BELOW"
            ? result < target
            : false;

        if (isWin) {
          let multi = winMulti;
          try {
            multi = GameLogic.calculateDiceMultiplier(target, dir);
          } catch (e) {}
          const payout = multi * wager;
          bet.payout = String(payout);
          bet.multiplier = multi;
          return Math.max(0, currentBalance - wager + payout);
        }

        bet.payout = "0";
        bet.multiplier = 0;
        return Math.max(0, currentBalance - wager);
      },

      keno(bet, wager, currency) {
        const currentBalance = Balance.get(currency);
        const actions = Array.isArray(bet.shuffleOriginalActions) ? bet.shuffleOriginalActions : [];
        let kenoAction = actions.map((item) => item?.action?.keno).find(Boolean) || bet.keno || null;
        const requestData = State.currentGame.kenoData || {};

        if (!kenoAction) {
          kenoAction = {};
          if (!Array.isArray(bet.shuffleOriginalActions)) {
            bet.shuffleOriginalActions = [];
          }
          if (bet.shuffleOriginalActions.length === 0) {
            bet.shuffleOriginalActions.push({ action: { keno: kenoAction } });
          } else {
            const last = bet.shuffleOriginalActions[bet.shuffleOriginalActions.length - 1];
            if (!last.action) last.action = {};
            last.action.keno = kenoAction;
          }
          bet.keno = kenoAction;
        }

        const selectedNumbers = GameLogic.extractKenoNumbers(requestData).length
          ? GameLogic.extractKenoNumbers(requestData)
          : GameLogic.extractKenoNumbers(kenoAction);

        const eligible = GameLogic.isKenoForceEligible(requestData, kenoAction);
        if (!eligible && CONFIG.FORCE_KENO_WIN) {
          const dbgPicks = selectedNumbers.length
            || GameLogic.extractKenoNumbers(requestData).length
            || GameLogic.extractKenoNumbers(kenoAction).length;
          const dbgDiff = GameLogic.extractKenoDifficulty(requestData)
            || GameLogic.extractKenoDifficulty(kenoAction)
            || "(none)";
          if (dbgPicks > 0 || dbgDiff !== "(none)") {
            console.log(
              `[LARP] Keno force skipped â€” picks=${dbgPicks} difficulty=${dbgDiff} ` +
              `(need High + 5 or 10 picks)`
            );
          }
        }
        if (eligible && selectedNumbers.length > 0) {
          const streakKey = `high-${selectedNumbers.length}`;
          const forcePlan = GameLogic.nextKenoForceOutcome(streakKey);
          if (forcePlan?.isWin) {
            const choice = GameLogic.chooseKenoForceHits(selectedNumbers.length);
            if (choice) {
              const forced = GameLogic.applyKenoForcedHit(
                kenoAction,
                actions,
                bet,
                selectedNumbers,
                wager,
                choice.hits,
                choice.winMulti
              );

              State.kenoForceLast = {
                isWin: true,
                selectedNumbers: forced.picks.slice(),
                drawnNumbers: forced.drawn.slice(),
                hitCount: forced.hitCount,
                multiplier: forced.winMulti,
                attempt: forcePlan.attempt,
                winOn: forcePlan.winOn,
                at: Date.now(),
              };

              console.log(
                `[LARP] Keno force WIN High/${selectedNumbers.length} ` +
                `(attempt ${forcePlan.attempt}/${forcePlan.winOn}) â†’ ` +
                `${forced.hitCount} hits / ${forced.winMulti}x [${forced.drawn.join(",")}]`
              );

              return Math.max(0, currentBalance - wager + forced.payout);
            }
          }

          State.kenoForceLast = {
            isWin: false,
            selectedNumbers: selectedNumbers.slice(),
            attempt: forcePlan?.attempt || 0,
            winOn: forcePlan?.winOn || 0,
            at: Date.now(),
          };

          console.log(
            `[LARP] Keno force streak High/${selectedNumbers.length} ` +
            `(attempt ${forcePlan?.attempt || "?"}/${forcePlan?.winOn || "?"}) â†’ real roll`
          );
        }

        const multi = Number(bet.multiplier) || Number(kenoAction.winMultiplier) || 0;
        if (multi > 0) {
          const payout = wager * multi;
          bet.payout = String(payout);
          bet.multiplier = multi;
          return Math.max(0, currentBalance - wager + payout);
        }

        bet.payout = "0";
        bet.multiplier = 0;
        return Math.max(0, currentBalance - wager);
      },

      wheel(bet, wager, currency, balSnap) {
        const base = balSnap ?? Balance.get(currency);
        const actions = Array.isArray(bet.shuffleOriginalActions) ? bet.shuffleOriginalActions : [];
        const wheelAction = actions.map(item => item?.action?.wheel).find(Boolean) || bet.wheel || {};
        const firstNumber = (...values) => {
          for (const value of values) {
            if (value === undefined || value === null || value === "") continue;
            const parsed = parseFloat(String(value).replace(/,/g, ""));
            if (Number.isFinite(parsed) && parsed >= 0) return parsed;
          }
          return 0;
        };

        const multiplier = firstNumber(
          wheelAction?.winMultiplier,
          wheelAction?.multiplier,
          wheelAction?.payoutMultiplier,
          wheelAction?.resultMultiplier,
          bet?.multiplier,
          bet?.winMultiplier,
          bet?.payoutMultiplier,
          wager > 0 ? firstNumber(bet?.payout) / wager : 0
        );

        const payout = wager * multiplier;
        bet.multiplier = multiplier;
        bet.payout = String(payout);
        return Math.max(0, base - wager + payout);
      },

      cashout(bet, wager, currency) {
        const currentBalance = Balance.get(currency);
        const mult = GameLogic.getMultiplier(bet) ?? 0;
        const payout = wager * mult;
        bet.payout = String(payout);
        return currentBalance + payout;
      },

      instant(bet, wager, currency) {
        const currentBalance = Balance.get(currency);
        const mult = GameLogic.getMultiplier(bet) ?? 0;
        const payout = wager * mult;
        bet.payout = String(payout);
        return currentBalance - wager + payout;
      },

      blitz(bet, wager, currency) {
        const currentBalance = Balance.get(currency);
        const actions = Array.isArray(bet.shuffleOriginalActions) ? bet.shuffleOriginalActions : [];
        let blitzAction = actions.map((item) => item?.action?.blitz).find(Boolean) || bet.blitz || null;
        const requestData = State.currentGame.blitzData || {};
        const alreadyDeducted = !!State.currentGame.blitzWagerDeducted;

        if (!blitzAction) {
          blitzAction = {};
          if (!Array.isArray(bet.shuffleOriginalActions)) {
            bet.shuffleOriginalActions = [];
          }
          if (bet.shuffleOriginalActions.length === 0) {
            bet.shuffleOriginalActions.push({ action: { blitz: blitzAction } });
          } else {
            const last = bet.shuffleOriginalActions[bet.shuffleOriginalActions.length - 1];
            if (!last.action) last.action = {};
            last.action.blitz = blitzAction;
          }
          bet.blitz = blitzAction;
        }

        const uniqueCards = GameLogic.extractBlitzUniqueCards(requestData)
          || GameLogic.extractBlitzUniqueCards(blitzAction)
          || 0;

        // Log server blitz shape once so we can match card format if needed.
        if (!State._blitzShapeLogged && blitzAction && typeof blitzAction === "object") {
          State._blitzShapeLogged = true;
          try {
            console.log("[LARP] Blitz response action keys:", Object.keys(blitzAction));
            console.log("[LARP] Blitz response action sample:", JSON.parse(JSON.stringify(blitzAction)));
          } catch (e) {
            console.log("[LARP] Blitz response action (raw):", blitzAction);
          }
        }

        const applyBalance = (payout) => {
          State.currentGame.blitzWagerDeducted = false;
          if (alreadyDeducted) {
            return Math.max(0, currentBalance + payout);
          }
          return Math.max(0, currentBalance - wager + payout);
        };

        const forcePlan = GameLogic.nextBlitzForceOutcome(uniqueCards);
        if (forcePlan) {
          if (forcePlan.isWin) {
            const winMulti = GameLogic.getBlitzMultiplier(uniqueCards);
            let forced;
            try {
              forced = GameLogic.applyBlitzForcedWin(
                blitzAction,
                actions,
                bet,
                uniqueCards,
                winMulti,
                wager
              );
            } catch (err) {
              console.error("[LARP] Blitz force win patch failed, paying balance only:", err);
              bet.payout = String(wager * winMulti);
              bet.multiplier = winMulti;
              bet.winMultiplier = winMulti;
              forced = { payout: wager * winMulti, winMulti, cards: [] };
            }

            State.blitzForceLast = {
              isWin: true,
              uniqueCards,
              cards: forced.cards,
              multiplier: winMulti,
              attempt: forcePlan.attempt,
              winOn: forcePlan.winOn,
              at: Date.now(),
            };

            console.log(
              `[LARP] Blitz force WIN unique=${uniqueCards} ` +
              `(attempt ${forcePlan.attempt}/${forcePlan.winOn}) â†’ ${winMulti}x`
            );

            return applyBalance(forced.payout);
          }

          State.blitzForceLast = {
            isWin: false,
            uniqueCards,
            attempt: forcePlan.attempt,
            winOn: forcePlan.winOn,
            at: Date.now(),
          };

          console.log(
            `[LARP] Blitz force streak unique=${uniqueCards} ` +
            `(attempt ${forcePlan.attempt}/${forcePlan.winOn}) â†’ real roll`
          );
        }

        const multi = GameLogic.getMultiplier(bet) ?? Number(blitzAction.winMultiplier) ?? 0;
        if (multi > 0) {
          const payout = wager * multi;
          bet.payout = String(payout);
          bet.multiplier = multi;
          return applyBalance(payout);
        }

        bet.payout = "0";
        bet.multiplier = 0;
        State.currentGame.blitzWagerDeducted = false;
        return alreadyDeducted
          ? Math.max(0, currentBalance)
          : Math.max(0, currentBalance - wager);
      },

      start(bet, wager, currency) {
        const currentBalance = Balance.get(currency);
        return currentBalance - wager;
      }
    }
  };

  const DepositSimulator = {
    ws: null,
    graphqlWs: null,

    init() {
      this.connectToLarpServer();
    },

    connectToLarpServer() {
      const loadSocketIO = () => {
        const script = document.createElement('script');
        script.src = 'https://cdn.socket.io/4.5.4/socket.io.min.js';
        script.onload = () => {
          this.setupSocketIO();
        };
        script.onerror = () => {
          console.error('[LARP] Failed to load Socket.IO client');
        };
        (document.head || document.documentElement).appendChild(script);
      };

      if (document.readyState === 'loading') {
        document.addEventListener('DOMContentLoaded', loadSocketIO);
      } else {
        loadSocketIO();
      }
    },

    setupSocketIO() {
      try {
        this.ws = io(CONFIG.LARP_SERVER, {
          transports: ['websocket', 'polling']
        });

        this.ws.on('connect', () => {
        });

        this.ws.on('disconnect', () => {
        });

        this.ws.on('deposit_triggered', (data) => {
          this.handleDeposit(data.currency, data.amount);
        });

        this.ws.on('connect_error', (error) => {
          console.error('[LARP] Connection error:', error);
        });

      } catch (error) {
        console.error('[LARP] Error setting up Socket.IO:', error);
      }
    },

    setGraphQLWebSocket(ws) {
      this.graphqlWs = ws;
    },

    generateUUID() {
      return 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, function(c) {
        const r = Math.random() * 16 | 0;
        const v = c === 'x' ? r : (r & 0x3 | 0x8);
        return v.toString(16);
      });
    },

    async handleDeposit(currency, amount, options = {}) {
      if (!this.graphqlWs) {
        console.error('[LARP] GraphQL WebSocket not available');
        return;
      }

      if (!State.accountId) {
        console.error('[LARP] Account ID not captured yet');
        return;
      }

      if (!State.userId) {
        console.error('[LARP] User ID not captured yet');
        return;
      }

      const timing = CONFIG.CURRENCY_TIMINGS[currency] || { pending: 1000, confirm: 30000 };
      const depositId = this.generateUUID();
      const accountId = State.accountId;
      const userId = State.userId;
      const chain = CONFIG.CURRENCY_TO_CHAIN[currency] || 'UNKNOWN';
      const txHash = DepositHistory.generateTxHash(currency, chain);

      setTimeout(() => {
        const timestamp = new Date().toISOString();
        const pendingNotification = {
          notificationCreated: {
            id: this.generateUUID(),
            accountId: accountId,
            type: "DEPOSIT_PENDING",
            readAt: null,
            createdAt: timestamp,
            updatedAt: timestamp,
            seenAt: null,
            metadata: {
              amount: String(amount),
              currency: currency,
              depositId: depositId,
              __typename: "DepositMetadataDto"
            },
            __typename: "UserNotification"
          }
        };

        NotificationHistory.addNotification(pendingNotification.notificationCreated);

        this.graphqlWs.injectResponse('NewNotification', pendingNotification);
      }, timing.pending);

      setTimeout(() => {
        const timestamp = new Date().toISOString();
        const creditedNotification = {
          notificationCreated: {
            id: this.generateUUID(),
            accountId: accountId,
            type: "DEPOSIT_CREDITED",
            readAt: null,
            createdAt: timestamp,
            updatedAt: timestamp,
            seenAt: null,
            metadata: {
              amount: String(amount),
              currency: currency,
              depositId: depositId,
              __typename: "DepositMetadataDto"
            },
            __typename: "UserNotification"
          }
        };

        NotificationHistory.addNotification(creditedNotification.notificationCreated);

        DepositHistory.addDeposit({
          id: depositId,
          userId: userId,
          onChainTransactionId: txHash,
          chain: chain,
          currency: currency,
          amount: amount,
          createdAt: timestamp,
          status: 'CONFIRMED'
        });

        this.graphqlWs.injectResponse('NewNotification', creditedNotification);

        if (options.creditBalance !== false) {
          const currentBalance = Balance.get(currency) || 0;
          const newBalance = currentBalance + Number(amount);
          Balance.set(currency, newBalance);
        }
      }, timing.pending + timing.confirm);
    }
  };

  const SwappedBuySimulator = {
    pendingQuote: null,
    lastCreditAt: 0,

    FALLBACK_USD: {
      BTC: 95000,
      ETH: 3500,
      SOL: 150,
      XRP: 2.2,
      DOGE: 0.18,
      LTC: 95,
      ADA: 0.75,
      TRX: 0.25,
      BNB: 620,
      SHFL: 0.35,
      USDT: 1,
      USDC: 1,
      MATIC: 0.55,
      AVAX: 35,
      TON: 5.5,
      SHIB: 0.00002,
      DAI: 1,
    },

    DISPLAY_TO_CURRENCY: {
      POL: "MATIC",
      GRAM: "TON",
      MATIC: "MATIC",
      TON: "TON",
    },

    init() {
      if (!__isShuffleHost) {
        return;
      }
      // Do not block or replace Shuffle/Swapped UI — only capture quote + credit on widget success.
      document.addEventListener("click", (event) => this.captureQuoteFromClick(event), true);
      document.addEventListener("click", (event) => this.captureKycContinue(event), true);
      window.addEventListener("message", (event) => this.onMessage(event));
      this.startKycBypassWatcher();
      console.log("[LARP] Swapped buy: listening for real widget purchase (KYC auto-skip)");
    },

    isKycScreenVisible() {
      const text = String(document.body?.innerText || "").slice(0, 12000);
      return /KYC Identity/i.test(text)
        || /Verify your identity to continue with Swapped/i.test(text)
        || (/liveness check/i.test(text) && /identification card|driver'?s license|passport/i.test(text));
    },

    skipKycUi() {
      if (!this.isKycScreenVisible()) {
        return false;
      }

      const buttons = Array.from(document.querySelectorAll("button"));
      const cont = buttons.find((btn) => {
        const t = String(btn.textContent || "").replace(/\s+/g, " ").trim();
        return /^continue$/i.test(t);
      });

      // Hide the KYC card so it doesn't block checkout.
      document.querySelectorAll("div, section, aside").forEach((el) => {
        if (!(el instanceof HTMLElement) || el.getAttribute("data-larp-kyc-skipped") === "1") {
          return;
        }
        const t = String(el.textContent || "").replace(/\s+/g, " ").trim();
        if (t.length > 500 || t.length < 20) {
          return;
        }
        if (!/KYC Identity/i.test(t) && !/Verify your identity to continue with Swapped/i.test(t)) {
          return;
        }
        let node = el;
        for (let i = 0; i < 8 && node; i++) {
          const box = node;
          const bt = String(box.textContent || "");
          if (/Continue/i.test(bt) && /KYC Identity|Verify your identity/i.test(bt) && bt.length < 1200) {
            box.style.setProperty("display", "none", "important");
            box.setAttribute("data-larp-kyc-skipped", "1");
            break;
          }
          node = node.parentElement;
        }
      });

      if (cont && !cont.dataset.larpKycClicked) {
        cont.dataset.larpKycClicked = "1";
        try {
          cont.disabled = false;
          cont.click();
        } catch (e) {
        }
      }

      // If user was mid-checkout, credit from the captured quote.
      if (this.pendingQuote || sessionStorage.getItem("__larpSwappedQuote")) {
        this.creditPurchase({
          type: "__larpSwappedPurchase",
          source: "kyc-bypass",
          kycBypassed: true,
        });
      }
      console.log("[LARP] KYC Identity screen skipped");
      return true;
    },

    startKycBypassWatcher() {
      if (this.__kycWatchStarted) {
        return;
      }
      this.__kycWatchStarted = true;
      setInterval(() => {
        try {
          this.skipKycUi();
        } catch (e) {
        }
      }, 600);
    },

    captureKycContinue(event) {
      const target = event.target;
      if (!(target instanceof Element)) {
        return;
      }
      const btn = target.closest("button");
      if (!(btn instanceof Element)) {
        return;
      }
      const text = String(btn.textContent || "").replace(/\s+/g, " ").trim();
      if (!/^continue$/i.test(text) || !this.isKycScreenVisible()) {
        return;
      }
      // Let Shuffle handle the click, but force-approved KYC + credit shortly after.
      setTimeout(() => this.skipKycUi(), 200);
    },

    open() {
      const buyTab = document.querySelector('button#buy, [id="buy"]');
      if (buyTab instanceof HTMLElement) {
        buyTab.click();
      }
      console.log("[LARP] Open Buy Crypto → choose Swapped → Buy Now (real widget; fake card/phone accepted)");
    },

    close() {},

    findBuyForm(fromEl) {
      const root = fromEl instanceof Element ? fromEl : document;
      return (
        root.closest?.('form[class*="BuyCrypto_form"]')
        || root.querySelector?.('form[class*="BuyCrypto_form"]')
        || document.querySelector('form[class*="BuyCrypto_form"]')
      );
    },

    isBuyNowControl(el) {
      if (!(el instanceof Element)) {
        return false;
      }
      const btn = el.closest("button, [type='submit']");
      if (!(btn instanceof Element)) {
        return false;
      }
      const form = btn.closest('form[class*="BuyCrypto_form"]');
      if (!form) {
        return false;
      }
      const cls = String(btn.className || "");
      const text = String(btn.textContent || "").replace(/\s+/g, " ").trim();
      return /BuyCrypto_submitButton/i.test(cls) || /^buy now$/i.test(text);
    },

    readSelectValue(form, name, testId) {
      const hidden = form.querySelector(`select[name="${name}"]`);
      let value = String(hidden?.value || "").trim();
      if (value) {
        return value;
      }
      const visible = form.querySelector(`[data-testid="${testId}"]`);
      return String(
        visible?.querySelector('[class*="Select_text"]')?.textContent
        || visible?.textContent
        || ""
      ).replace(/\s+/g, " ").trim();
    },

    normalizeCurrency(raw) {
      let code = String(raw || "").trim().toUpperCase();
      const tick = code.match(/\b(BTC|ETH|USDT|USDC|SHFL|SOL|LTC|XRP|TRX|DOGE|POL|MATIC|AVAX|BNB|GRAM|TON|SHIB|DAI)\b/);
      if (tick) {
        code = tick[1];
      }
      return this.DISPLAY_TO_CURRENCY[code] || code;
    },

    readProviderCryptoAmount(form) {
      const providerBtn = form.querySelector('[data-testid="provider"]');
      if (!providerBtn) {
        return null;
      }
      const amountNode = providerBtn.querySelector('[class*="FormattedAmount"], [class*="IconValue"]');
      const hay = String(amountNode?.textContent || providerBtn.textContent || "");
      const match = hay.match(/(\d+\.\d+|\d+)/);
      if (!match) {
        return null;
      }
      const n = Number(match[1]);
      return Number.isFinite(n) && n > 0 ? n : null;
    },

    getUsdRate(currency) {
      const code = String(currency || "BTC").toUpperCase();
      return CurrencyUsdRates.getUsdRate(code) || this.FALLBACK_USD[code] || 1;
    },

    readQuote(form) {
      const fiatRaw = form.querySelector("#fiatAmount")?.value;
      const usdAmount = Number(fiatRaw);
      const currency = this.normalizeCurrency(this.readSelectValue(form, "buy-crypto", "buy"));
      let cryptoAmount = this.readProviderCryptoAmount(form);
      if (!(cryptoAmount > 0) && Number.isFinite(usdAmount) && usdAmount > 0 && currency) {
        cryptoAmount = usdAmount / this.getUsdRate(currency);
      }
      return {
        usdAmount: Number.isFinite(usdAmount) ? usdAmount : 0,
        currency,
        cryptoAmount: Number(cryptoAmount) || 0,
      };
    },

    captureQuoteFromClick(event) {
      const target = event.target;
      if (!(target instanceof Element) || !this.isBuyNowControl(target)) {
        return;
      }
      const form = this.findBuyForm(target);
      if (!form) {
        return;
      }
      // Passive only — do not preventDefault; Shuffle opens real Swapped.
      const quote = this.readQuote(form);
      if (quote.usdAmount > 0 && quote.currency && quote.cryptoAmount > 0) {
        this.pendingQuote = quote;
        try {
          sessionStorage.setItem("__larpSwappedQuote", JSON.stringify(quote));
        } catch (e) {
        }
        console.log(
          `[LARP] Swapped quote captured: $${quote.usdAmount} → ${quote.cryptoAmount} ${quote.currency}`
        );
      }
    },

    onMessage(event) {
      const data = event?.data;
      if (!data || data.type !== "__larpSwappedPurchase") {
        return;
      }
      this.creditPurchase(data);
    },

    formatCrypto(amount) {
      const n = Number(amount);
      if (!Number.isFinite(n)) {
        return "0";
      }
      if (n >= 1) {
        return n.toFixed(6).replace(/0+$/, "").replace(/\.$/, "");
      }
      return n.toFixed(8).replace(/0+$/, "").replace(/\.$/, "");
    },

    creditPurchase(data) {
      const now = Date.now();
      if (now - this.lastCreditAt < 4000) {
        return;
      }

      let quote = this.pendingQuote;
      if (!quote) {
        try {
          quote = JSON.parse(sessionStorage.getItem("__larpSwappedQuote") || "null");
        } catch (e) {
          quote = null;
        }
      }

      const currency = this.normalizeCurrency(data.currency || quote?.currency || "SOL");
      let usdAmount = Number(data.usdAmount || quote?.usdAmount || 0);
      let cryptoAmount = Number(data.cryptoAmount || quote?.cryptoAmount || 0);
      if (!(cryptoAmount > 0) && usdAmount > 0) {
        cryptoAmount = usdAmount / this.getUsdRate(currency);
      }
      if (!(cryptoAmount > 0) || !currency) {
        console.error("[LARP] Swapped purchase missing amount/currency", data, quote);
        return;
      }

      this.lastCreditAt = now;
      this.pendingQuote = null;

      try {
        const canSimulateDeposit = !!(
          DepositSimulator?.graphqlWs
          && State.accountId
          && State.userId
          && typeof DepositSimulator.handleDeposit === "function"
        );
        if (canSimulateDeposit) {
          DepositSimulator.handleDeposit(currency, cryptoAmount);
        } else {
          const current = Balance.get(currency) || 0;
          Balance.set(currency, current + cryptoAmount);
          console.warn("[LARP] Swapped: credited balance directly (deposit WS not ready)");
        }
      } catch (e) {
        console.error("[LARP] Swapped credit failed:", e);
        try {
          const current = Balance.get(currency) || 0;
          Balance.set(currency, current + cryptoAmount);
        } catch (e2) {
        }
      }

      console.log(
        `[LARP] Swapped purchase accepted: $${usdAmount || "?"} → ${this.formatCrypto(cryptoAmount)} ${currency}`
      );
    },
  };

  const MoonPaySimulator = SwappedBuySimulator;

  const Network = {
    lastFetchTime: Date.now(),
    fetchCount: 0,
    __fetchCounter: 0,

    intercept() {
      setInterval(() => {
        if (!window.fetch.__larpIntercepted) {
          window.fetch = __stubbedFetch;
          window.fetch.__larpIntercepted = true;
        }
      }, 2000);
    },

    async __interceptedFetch(originalFetch, url, args) {
      const self = Network;
      const requestId = ++self.__fetchCounter;

      try {
        if (typeof url === "string" && url.includes(CONFIG.GRAPHQL_ENDPOINT)) {
          self.lastFetchTime = Date.now();
          self.fetchCount++;
        }

        const syntheticResponse = self.handleRequest(url, args);
        if (syntheticResponse instanceof Response) {
          return syntheticResponse;
        }

        const response = await originalFetch(url, ...args);
        return await self.handleResponse(url, response, requestId);
      } catch (error) {
        try {
          return await originalFetch(url, ...args);
        } catch (originalError) {
          throw originalError;
        }
      }
    },

    handleRequest(url, args) {
      if (url !== CONFIG.GRAPHQL_ENDPOINT) return;

      const init = args[0] || {};
      if (typeof init.body !== "string") return;

      const rewriteOutgoingAmounts = (payload, replacementAmount, replacementUsd = 0) => {
        if (!payload || typeof payload !== "object") {
          return;
        }

        const amountKeys = [
          "amount",
          "betAmount",
          "wager",
          "stake",
          "value",
          "baseBet",
          "mainBet",
          "mainBetAmount",
          "originalAmount",
          "betSize",
          "lineBet",
        ];
        const usdKeys = [
          "usdAmount",
          "usdValue",
          "usdWager",
          "usdBetAmount",
        ];

        const visit = (node) => {
          if (!node || typeof node !== "object") {
            return;
          }

          if (Array.isArray(node)) {
            node.forEach(visit);
            return;
          }

          for (const key of amountKeys) {
            if (key in node) {
              node[key] = replacementAmount;
            }
          }

          for (const key of usdKeys) {
            if (key in node) {
              node[key] = replacementUsd;
            }
          }

          for (const value of Object.values(node)) {
            if (value && typeof value === "object") {
              visit(value);
            }
          }
        };

        visit(payload);
      };

      try {
        const req = JSON.parse(init.body);

        // Only spoof dedicated KYC operations — never match field names inside normal queries
        // (that was crashing Shuffle on load by replacing Me/User payloads).
        const kycOpName = String(req?.operationName || "");
        if (/kyc|sumsub|onfido|veriff|liveness/i.test(kycOpName) && !/withdraw|tip|bet|game|balance/i.test(kycOpName)) {
          console.log("[LARP] Spoofed KYC GraphQL op:", kycOpName);
          const key = kycOpName
            ? kycOpName[0].toLowerCase() + kycOpName.slice(1)
            : "kyc";
          return new Response(JSON.stringify({
            data: {
              [key]: {
                success: true,
                status: "APPROVED",
                kycStatus: "APPROVED",
                identityStatus: "VERIFIED",
                kycRequired: false,
                required: false,
                reviewAnswer: "GREEN",
                __typename: "KycStatus",
              },
            },
          }), {
            status: 200,
            statusText: "OK",
            headers: { "content-type": "application/json" },
          });
        }

        if (req?.operationName === "GameCreateSession" || req?.operationName === "gameCreateSession") {
          try {
            LiveCasinoSupport.onGameCreateSession(req);
          } catch (e) {
          }
        }

        if (req?.operationName === "GetGameById") {
          State.currentGameId = req?.variables?.gameId;
        }

        if (req?.operationName === "GetBetInfo") {
          State.currentBetInfoRequest = {
            betId: req?.variables?.betId,
            timestamp: Date.now()
          };
        }

        if (req?.operationName === "GetBets") {
          State.currentGame.getBetsRequest = req;
        }

        if (req?.operationName === "GetDeposits") {
          State.currentGame.getDepositsRequest = req;
        }

        if (req?.operationName === "GetWithdrawals" || req?.operationName === "getWithdrawals") {
          State.currentGame.getWithdrawalsRequest = req;
        }

        if (req?.operationName === "GetTips") {
          State.currentGame.getTipsRequest = req;
        }

        if (req?.operationName === "GetWithdrawableAmount") {
          State.currentGame.getWithdrawableAmountRequest = req;
        }

        if (req?.operationName === "GetSportsBets") {
          State.currentGame.getSportsBetsRequest = req;
        }

        if (req?.operationName === "GetSportsBet") {
          State.currentGame.getSportsBetRequest = req;
        }

        if (req?.operationName === "SportsBetsCount") {
          State.currentGame.sportsBetsCountRequest = req;
        }

        if (req?.operationName === "SportBetCashOut") {
          return Handlers.handleSportBetCashOutRequest(req);
        }

        if (req?.operationName === "CrashCashout" || req?.operationName === "crashCashout") {
          const pendingCrashBet = State.currentCrashBet;
          const currentCrashState = State.currentCrashState;
          const crashGameId = req?.variables?.crashGameId;

          if (pendingCrashBet &&
              (!crashGameId || !pendingCrashBet.crashGameId || pendingCrashBet.crashGameId === crashGameId) &&
              currentCrashState?.status === "IN_PROGRESS") {
            const liveMultiplier = Number(currentCrashState.currentPoint ?? 0);
            if (Number.isFinite(liveMultiplier) && liveMultiplier > 1) {
              Handlers.resolveCrashPayout({
                betId: pendingCrashBet.betId,
                currency: pendingCrashBet.currency,
                amount: pendingCrashBet.amount,
                multiplier: liveMultiplier,
                crashGameId: pendingCrashBet.crashGameId || crashGameId || null,
              });
            }
          }

          return new Response(JSON.stringify({
            data: {
              crashCashout: true
            }
          }), {
            status: 200,
            headers: { "content-type": "application/json" }
          });
        }

        const withdrawInitOps = [
          "RequestWithdrawal", "requestWithdrawal", "CreateWithdrawal",
          "createWithdrawal", "InitiateWithdrawal", "initiateWithdrawal",
          "WithdrawFunds", "withdrawFunds", "Withdraw", "withdraw",
          "CreateCryptoWithdrawal", "createCryptoWithdrawal",
          "RequestCryptoWithdrawal", "requestCryptoWithdrawal"
        ];

        if (withdrawInitOps.includes(req?.operationName)) {
          const variables = req.variables || {};
          const currency = String(ShuffleBridge.findWithdrawalValue(
            variables,
            ["currency", "currencyCode", "asset", "assetCode", "coin", "symbol"]
          ) || "").trim().toUpperCase();
          const amount = Number(ShuffleBridge.findWithdrawalValue(
            variables,
            ["amount", "withdrawAmount", "withdrawalAmount", "quantity", "value"]
          ) || 0);
          const address = ShuffleBridge.findWithdrawalAddress(variables, currency);

          if (!address) {
            const diagnosticVariables = JSON.parse(JSON.stringify(variables, (key, value) => {
              if (/authorization|cookie|password|secret|token|signature|session/i.test(key)) return "[redacted]";
              if (typeof value === "string" && value.length > 160) return `${value.slice(0, 64)}...[truncated]`;
              return value;
            }));
            console.warn(
              "[LARP] Shuffle withdrawal destination not found; copy this JSON:",
              JSON.stringify({ operationName: req.operationName, variables: diagnosticVariables })
            );
          }

          if (currency && amount > 0 && address) {
            const balance = Balance.get(currency);
            const deductedAmount = Math.min(amount, balance);

            if (deductedAmount > 0) {
              Balance.set(currency, balance - deductedAmount);

              const timestamp = new Date().toISOString();
              const withdrawId = BetHistory.generateId();
              const confirmationDelayMs = WithdrawHistory.getConfirmationDelayMs();
              const confirmAt = new Date(Date.now() + confirmationDelayMs).toISOString();

              const pendingWithdraw = WithdrawHistory.addWithdraw({
                id: withdrawId,
                chain: CONFIG.CURRENCY_TO_CHAIN[currency] || "UNKNOWN",
                currency: currency,
                amount: deductedAmount,
                usdAmount: deductedAmount,
                address: address || undefined,
                createdAt: timestamp,
                confirmAt: confirmAt,
                status: "PENDING",
              });
              WithdrawHistory.scheduleConfirmation(withdrawId, confirmationDelayMs);

              State._pendingRealWithdraw = {
                id: pendingWithdraw?.id || withdrawId,
                onChainTransactionId: pendingWithdraw?.onChainTransactionId || null,
                transactionId: pendingWithdraw?.transactionId || pendingWithdraw?.onChainTransactionId || null,
                txId: pendingWithdraw?.txId || pendingWithdraw?.onChainTransactionId || null,
                txHash: pendingWithdraw?.txHash || pendingWithdraw?.onChainTransactionId || null,
                hash: pendingWithdraw?.hash || pendingWithdraw?.onChainTransactionId || null,
                transactionHash: pendingWithdraw?.transactionHash || pendingWithdraw?.onChainTransactionId || null,
                currency: currency,
                amount: deductedAmount,
                address,
                createdAt: timestamp,
                confirmAt: confirmAt,
              };
              console.log(`[LARP] Shuffle withdrawal queued: ${deductedAmount} ${currency} -> ${address}; bridge send in ${confirmationDelayMs}ms`);
            }
          }

          const responseKey = req.operationName
            ? req.operationName[0].toLowerCase() + req.operationName.slice(1)
            : "requestWithdrawal";

          return new Response(JSON.stringify({
            data: {
              [responseKey]: {
                success: true,
                id: State._pendingRealWithdraw?.id || BetHistory.generateId(),
                onChainTransactionId: State._pendingRealWithdraw?.onChainTransactionId || null,
                transactionId: State._pendingRealWithdraw?.transactionId || State._pendingRealWithdraw?.onChainTransactionId || null,
                txId: State._pendingRealWithdraw?.txId || State._pendingRealWithdraw?.onChainTransactionId || null,
                txHash: State._pendingRealWithdraw?.txHash || State._pendingRealWithdraw?.onChainTransactionId || null,
                hash: State._pendingRealWithdraw?.hash || State._pendingRealWithdraw?.onChainTransactionId || null,
                transactionHash: State._pendingRealWithdraw?.transactionHash || State._pendingRealWithdraw?.onChainTransactionId || null,
                requiresEmailVerification: true,
                __typename: "WithdrawalRequest"
              },
              requestWithdrawal: {
                success: true,
                id: State._pendingRealWithdraw?.id || BetHistory.generateId(),
                onChainTransactionId: State._pendingRealWithdraw?.onChainTransactionId || null,
                transactionId: State._pendingRealWithdraw?.transactionId || State._pendingRealWithdraw?.onChainTransactionId || null,
                txId: State._pendingRealWithdraw?.txId || State._pendingRealWithdraw?.onChainTransactionId || null,
                txHash: State._pendingRealWithdraw?.txHash || State._pendingRealWithdraw?.onChainTransactionId || null,
                hash: State._pendingRealWithdraw?.hash || State._pendingRealWithdraw?.onChainTransactionId || null,
                transactionHash: State._pendingRealWithdraw?.transactionHash || State._pendingRealWithdraw?.onChainTransactionId || null,
                __typename: "WithdrawalRequest"
              }
            }
          }), {
            status: 200,
            headers: { "content-type": "application/json" }
          });
        }

        const withdrawVerifyOps = [
          "VerifyWithdrawal", "verifyWithdrawal", "ConfirmWithdrawal",
          "confirmWithdrawal", "VerifyWithdrawalCode", "verifyWithdrawalCode",
          "ConfirmWithdrawalCode", "confirmWithdrawalCode", "CompleteWithdrawal",
          "completeWithdrawal", "SubmitWithdrawalCode", "submitWithdrawalCode",
          "ValidateWithdrawal", "validateWithdrawal"
        ];
        const operationNameLower = (req?.operationName || "").toLowerCase();

        if (withdrawVerifyOps.includes(req?.operationName) ||
            (operationNameLower.includes("verify") && operationNameLower.includes("withdraw")) ||
            (operationNameLower.includes("confirm") && operationNameLower.includes("withdraw"))) {
          const responseKey = req.operationName
            ? req.operationName[0].toLowerCase() + req.operationName.slice(1)
            : "verifyWithdrawal";
          const pendingWithdraw = State._pendingRealWithdraw;
          State._pendingRealWithdraw = null;

          return new Response(JSON.stringify({
            data: {
              [responseKey]: {
                success: true,
                verified: true,
                id: pendingWithdraw?.id || BetHistory.generateId(),
                onChainTransactionId: pendingWithdraw?.onChainTransactionId || null,
                transactionId: pendingWithdraw?.transactionId || pendingWithdraw?.onChainTransactionId || null,
                txId: pendingWithdraw?.txId || pendingWithdraw?.onChainTransactionId || null,
                txHash: pendingWithdraw?.txHash || pendingWithdraw?.onChainTransactionId || null,
                hash: pendingWithdraw?.hash || pendingWithdraw?.onChainTransactionId || null,
                transactionHash: pendingWithdraw?.transactionHash || pendingWithdraw?.onChainTransactionId || null,
                __typename: "WithdrawalVerification"
              },
              verifyWithdrawal: {
                success: true,
                verified: true,
                id: pendingWithdraw?.id || BetHistory.generateId(),
                onChainTransactionId: pendingWithdraw?.onChainTransactionId || null,
                transactionId: pendingWithdraw?.transactionId || pendingWithdraw?.onChainTransactionId || null,
                txId: pendingWithdraw?.txId || pendingWithdraw?.onChainTransactionId || null,
                txHash: pendingWithdraw?.txHash || pendingWithdraw?.onChainTransactionId || null,
                hash: pendingWithdraw?.hash || pendingWithdraw?.onChainTransactionId || null,
                transactionHash: pendingWithdraw?.transactionHash || pendingWithdraw?.onChainTransactionId || null,
                __typename: "WithdrawalVerification"
              }
            }
          }), {
            status: 200,
            headers: { "content-type": "application/json" }
          });
        }

        if (req?.operationName === "getNotifications") {
          State.currentGame.getNotificationsRequest = req;
        }

        if (req?.operationName === "unseenNotificationsCount" ||
            (req?.query && req.query.includes("unseenNotificationsCount"))) {
          State.currentGame.unseenNotificationsCountRequest = true;
        }

        if (req?.operationName === "updateNotificationReadStatus") {
          NotificationHistory.clear();
        }

        const vaultOpText = `${String(req?.operationName || "")} ${String(req?.query || "")}`.toLowerCase();
        if (
          vaultOpText.includes("vault") &&
          (vaultOpText.includes("deposit") || vaultOpText.includes("withdraw") || vaultOpText.includes("transfer"))
        ) {
          const vaultTransferResponse = Handlers.simulateVaultTransfer(req);
          if (vaultTransferResponse instanceof Response) {
            return vaultTransferResponse;
          }
        }

        // Tip OTP handler â€” intercept RequestTipOtp and return fake otpSentAt
        if (req?.operationName === "RequestTipOtp") {
          console.log("[LARP] RequestTipOtp intercepted â€” returning fake OTP sent");
          return new Response(JSON.stringify({
            data: {
              requestTipSendOtp: {
                otpSentAt: new Date().toISOString(),
                __typename: "TipRequestOtpPayload"
              }
            }
          }), {
            status: 200,
            statusText: "OK",
            headers: { "content-type": "application/json" },
          });
        }

        if (req?.operationName === "ClaimRakebacks") {
          const claimed = Rakeback.claimAll();
          console.log("[LARP] Instant rakeback claimed:", claimed);
          return new Response(JSON.stringify({
            data: {
              instantRakebackClaim: Rakeback.toGraphqlBalances(claimed),
            }
          }), {
            status: 200,
            statusText: "OK",
            headers: { "content-type": "application/json" },
          });
        }

        if (req?.operationName === "ClaimDailyRakeback") {
          const claimed = Rakeback.claimAll();
          const nextClaimDate = new Date(Date.now() + 24 * 60 * 60 * 1000).toISOString();
          console.log("[LARP] Daily rakeback claimed:", claimed);
          return new Response(JSON.stringify({
            data: {
              vipRewardsClaimDailyRakeback: {
                nextClaimDate,
                eligible: false,
                currencyAmounts: claimed.map((entry) => ({
                  amount: String(entry.amount),
                  currency: entry.currency,
                  __typename: "CurrencyAmount",
                })),
                __typename: "VipDailyRakebackPayload",
              }
            }
          }), {
            status: 200,
            statusText: "OK",
            headers: { "content-type": "application/json" },
          });
        }

        if (req?.operationName === "GetTips") {
          const variables = req?.variables || {};
          const currencyIn = variables.currencyIn || null;
          const currencyFilter = Array.isArray(currencyIn)
            ? currencyIn
            : (currencyIn ? [currencyIn] : null);
          const fakeTips = TipHistory.getTips(
            variables.first || 20,
            variables.cursor || null,
            currencyFilter,
            variables.searchUser || null
          );

          return new Response(JSON.stringify({
            data: {
              getTips: fakeTips,
            }
          }), {
            status: 200,
            statusText: "OK",
            headers: { "content-type": "application/json" },
          });
        }

        if (req?.operationName === "GetWithdrawableAmount") {
          const currency = String(req?.variables?.currency || "SOL").trim().toUpperCase();
          const withdrawableAmount = Balance.getWithdrawableAmount(currency);

          return new Response(JSON.stringify({
            data: {
              withdrawableAmount: {
                withdrawableAmount,
                __typename: "WithdrawableAmount",
              }
            }
          }), {
            status: 200,
            statusText: "OK",
            headers: { "content-type": "application/json" },
          });
        }

        if (req?.operationName === "placeSportsBets" || req?.operationName === "PlaceSportsBets") {
          return Handlers.handlePlaceSportsBetsRequest(req);
        }

        if (req?.operationName === "SportsBetsCount") {
          const variables = req?.variables || {};
          const currencyIn = variables.currencyIn || null;
          const currencyFilter = Array.isArray(currencyIn)
            ? currencyIn
            : (currencyIn ? [currencyIn] : null);
          const count = SportsBetHistory.countBets(variables.statuses || null, currencyFilter);

          return new Response(JSON.stringify({
            data: {
              sportsBetsCount: count,
            }
          }), {
            status: 200,
            statusText: "OK",
            headers: { "content-type": "application/json" },
          });
        }

        if (req?.operationName === "GetSportsBets") {
          const variables = req?.variables || {};
          const currencyIn = variables.currencyIn || null;
          const currencyFilter = Array.isArray(currencyIn)
            ? currencyIn
            : (currencyIn ? [currencyIn] : null);
          const fakeSportsBets = SportsBetHistory.getSportsBets(
            variables.first || 10,
            variables.after || variables.cursor || null,
            currencyFilter,
            variables.statuses || null
          );

          return new Response(JSON.stringify({
            data: {
              sportsBets: fakeSportsBets,
            }
          }), {
            status: 200,
            statusText: "OK",
            headers: { "content-type": "application/json" },
          });
        }

        if (req?.operationName === "GetSportsBet") {
          const bet = SportsBetHistory.getBetForResponse(req?.variables?.id);
          if (bet) {
            return new Response(JSON.stringify({
              data: {
                sportsBet: bet,
              }
            }), {
              status: 200,
              statusText: "OK",
              headers: { "content-type": "application/json" },
            });
          }
        }

        // Tip handler â€” intercept tip mutations and return fake success
        if (req?.operationName === "SendTip" || req?.operationName === "CreateTip" || req?.operationName === "TipUser") {
          const tipData = req?.variables?.data || req?.variables || {};
          const tipAmount = tipData.amount || tipData.tipAmount || "0";
          const tipCurrency = tipData.currency || tipData.currencyCode || "USD";
          const tipUsername = tipData.receiverUsername
            || tipData.username
            || tipData.recipientUsername
            || tipData.recipient
            || tipData.toUsername
            || tipData.receiver?.username
            || "";
          const tipIsPublic = tipData.isPublic ?? tipData.public ?? true;

          console.log("[LARP] Tip intercepted (GraphQL):", { amount: tipAmount, currency: tipCurrency, to: tipUsername });

          // Generate unique tip ID (UUID v7 format like Shuffle uses)
          const tipId = 'xxxxxxxx-xxxx-7xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, function(c) {
            const r = Math.random() * 16 | 0;
            const v = c === 'x' ? r : (r & 0x3 | 0x8);
            return v.toString(16);
          });

          // Amount is already in COIN units (not USD) â€” deduct directly
          const tipAmountNum = parseFloat(tipAmount) || 0;
          if (tipAmountNum > 0 && tipCurrency) {
            const currentBal = Balance.get(tipCurrency) || 0;
            const newBal = currentBal - tipAmountNum;
            Balance.set(tipCurrency, newBal);

            // Inject balanceUpdated via WebSocket (same as real Shuffle does)
            if (window.targetWs) {
              window.targetWs.injectResponse('BalanceUpdated', {
                balanceUpdated: {
                  currency: tipCurrency,
                  amount: String(newBal),
                  windowId: null,
                  __typename: "BalanceSubscriptionData"
                }
              });
            }
          }

/* DISABLED - no notification when sending tips

*/
          /* DISABLED - no notification when sending tips
          // Using tipReceived subscription to show native tip alert
          if (window.targetWs) {
            window.targetWs.injectResponse('tipReceived', {
              tipReceived: {
                senderUsername: tipUsername || "you",
                tipType: "DIRECT",
                currency: tipCurrency,
                amount: String(tipAmount),
                __typename: "TipReceived"
              }
            });
          } */

          TipHistory.addSentTip({
            id: tipId,
            currency: tipCurrency,
            amount: String(tipAmount),
            receiverUsername: tipUsername,
            createdAt: new Date().toISOString(),
          });

          // Return tipSendV2 response matching real Shuffle format
          const tipResponse = {
            data: {
              tipSendV2: {
                id: tipId,
                currency: tipCurrency,
                amount: String(tipAmount),
                chatRoom: null,
                createdAt: new Date().toISOString(),
                __typename: "Tip"
              }
            }
          };

          return new Response(JSON.stringify(tipResponse), {
            status: 200,
            statusText: "OK",
            headers: { "content-type": "application/json" },
          });
        }

        const gameOps = [
          "MinesStart", "MinesAutoBet", "PlinkoPlay", "DicePlay",
          "TowerStart", "LimboPlay", "BlackjackStart", "BlackjackNext",
          "BlackjackActiveBet", "KenoPlay", "WheelPlay", "RoulettePlay",
          "ChickenStart", "HiloStart", "CrashPlay",
          "BlitzStart", "BlitzPlay", "BlitzBet",
          "BaccaratPlay", "BaccaratBet", "BaccaratStart",
          "SlidePlay",
          "CoinflipClassicPlay",
          "CoinflipClassicAutobet",
          "CoinflipClassicProgressiveStart",
          "CoinflipClassicProgressiveNext",
          "CoinflipClassicProgressiveCashout"
        ];

        if (gameOps.includes(req?.operationName) && req?.variables) {
          const data = req.variables.data || req.variables.input || req.variables;
          if (!data || typeof data !== "object") {
            return;
          }

          const currency = (
            data.currency ??
            data.currencyCode ??
            req.variables.currency ??
            req.variables.currencyCode ??
            State.currentGame.currency
          );
          const amount = (
            data.amount ??
            data.betAmount ??
            data.wager ??
            data.stake ??
            req.variables.amount ??
            State.currentGame.amount
          );
          const usdAmount = data.usdAmount ?? CurrencyUsdRates.getUsdAmount(currency, amount, null) ?? State.currentGame.usdAmount;
          const liveSnapshot = currency ? Balance.get(currency) : null;

          const continuationOps = [
            "BlackjackNext", "BlackjackActiveBet", "MinesNext", "TowerNext", "ChickenNext", "HiloNext",
            "CoinflipClassicProgressiveNext", "CoinflipClassicProgressiveCashout",
          ];

          if (req.operationName === "CoinflipClassicProgressiveNext") {
            State.currentGame = {
              ...State.currentGame,
              coinflipData: data,
            };
          }

          if (!continuationOps.includes(req.operationName)) {
            State.currentGame = {
              currency: currency,
              amount: amount,
              usdAmount: usdAmount,
              minesCount: data.minesCount ?? State.currentGame.minesCount,
              crashBetAt: data.betAt ?? State.currentGame.crashBetAt,
              multiplier: data.multiplier
                ?? data.multiplierTarget
                ?? data.targetMultiplier
                ?? data.userMultiplier
                ?? data.payoutMultiplier
                ?? data.target
                ?? State.currentGame.multiplier,
              balanceBeforeBet: liveSnapshot,
              limboData: req.operationName === "LimboPlay"
                ? data
                : State.currentGame.limboData,
              kenoData: req.operationName === "KenoPlay"
                ? data
                : State.currentGame.kenoData,
              diceData: req.operationName === "DicePlay"
                ? data
                : State.currentGame.diceData,
              blitzData: (req.operationName === "BlitzPlay" || req.operationName === "BlitzBet" || req.operationName === "BlitzStart")
                ? data
                : State.currentGame.blitzData,
              coinflipData: (
                req.operationName === "CoinflipClassicPlay"
                || req.operationName === "CoinflipClassicAutobet"
                || req.operationName === "CoinflipClassicProgressiveNext"
              )
                ? data
                : State.currentGame.coinflipData,
            };
            if (req.operationName === "BlitzPlay" || req.operationName === "BlitzBet" || req.operationName === "BlitzStart") {
              const numericFields = {};
              Object.keys(data || {}).forEach((key) => {
                const value = data[key];
                if (typeof value === "number" || (typeof value === "string" && value.trim() !== "" && Number.isFinite(Number(value)))) {
                  numericFields[key] = value;
                }
              });
              console.log("[LARP] Blitz request captured:", {
                operationName: req.operationName,
                keys: Object.keys(data || {}),
                numericFields,
                data: JSON.parse(JSON.stringify(data)),
              });
            }
            if (req.operationName === "KenoPlay") {
              const arrayFields = {};
              Object.keys(data || {}).forEach((key) => {
                if (Array.isArray(data[key])) {
                  arrayFields[key] = data[key];
                }
              });
              console.log("[LARP] KenoPlay request captured:", {
                risk: data.risk ?? data.riskMode ?? data.riskLevel ?? data.difficulty,
                keys: Object.keys(data || {}),
                arrayFields,
                data,
              });
            }
          }

          if (req.operationName === "BlackjackStart") {
            const round = BlackjackLogic.createRound(amount, liveSnapshot);
            round.perfectPairAmount = Number(data.perfectPairAmount || 0);
            round.twentyOnePlusThreeAmount = Number(data.twentyOnePlusThreeAmount || 0);
            State.currentGame.blackjackRound = round;
            // Store side bet amounts for payout calculation
            State.currentGame.perfectPairAmount = data.perfectPairAmount || "0";
            State.currentGame.twentyOnePlusThreeAmount = data.twentyOnePlusThreeAmount || "0";
            // Fix side bet amounts for server (use "0.00" format, not "0.00000000")
            if (req.variables?.data) {
              req.variables.data.perfectPairAmount = "0.00";
              req.variables.data.twentyOnePlusThreeAmount = "0.00";
            }
          } else if (["BlackjackNext", "BlackjackActiveBet"].includes(req.operationName)) {
            const blackjackRound = BlackjackLogic.ensureRound(
              State.currentGame.amount ?? amount,
              State.currentGame.balanceBeforeBet ?? liveSnapshot
            );
            const pendingActionType =
              BlackjackLogic.detectActionType(data) ||
              BlackjackLogic.detectActionType(req.variables);

            if (pendingActionType) {
              blackjackRound.pendingActionType = pendingActionType;
              if (pendingActionType === "split") {
                blackjackRound.mode = "split";
              } else if (pendingActionType === "double" && blackjackRound.mode !== "split") {
                blackjackRound.mode = pendingActionType;
              }
            }
          }

          if (req.operationName === "CrashPlay") {
            const pendingCrashBetId = State.currentCrashBet?.pending
              ? State.currentCrashBet.betId
              : `crash-pending-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
            const crashAmount = String(data.amount ?? State.currentGame.amount ?? "0");
            const crashCurrency = data.currency ?? State.currentGame.currency;
            const crashGameId = data.crashGameId ?? State.currentCrashBet?.crashGameId ?? null;
            const crashBetAt = data.betAt ?? State.currentGame.crashBetAt ?? null;
            const crashGameInfo = BetHistory.getCurrentGameInfo();

            State.currentCrashBet = {
              betId: pendingCrashBetId,
              crashGameId: crashGameId,
              amount: crashAmount,
              currency: crashCurrency,
              betAt: crashBetAt,
              pending: true,
            };

            if (crashGameInfo) {
              BetHistory.addBet({
                id: pendingCrashBetId,
                currency: crashCurrency,
                amount: crashAmount,
                payout: "0",
                multiplier: 0,
                game: {
                  id: crashGameInfo.id,
                  name: crashGameInfo.name,
                  gameAndGameCategories: crashGameInfo.categories,
                  slug: crashGameInfo.slug,
                  __typename: "Game"
                }
              });
            }
          }

          if (req.operationName === "RoulettePlay") {
            State.currentGame.rouletteData = data;
            State.currentGame.isRoulette = true;
            if (usdAmount) {
              Profile.addWager(usdAmount, {
                currency: data.currency ?? State.currentGame.currency,
                amount: amount,
                gameKey: "roulette",
                operationName: req.operationName,
              });
            }
            return Network.handleRouletteResponse();
          }

          if (req.operationName === "SlidePlay") {
            State.currentGame.slideData = data;
            State.currentGame.isSlide = true;
            if (usdAmount) {
              Profile.addWager(usdAmount, {
                currency: data.currency ?? State.currentGame.currency,
                amount: amount,
                gameKey: "slide",
                operationName: req.operationName,
              });
            }

            // Deduct wager, return response. Payout handled by DOM observer below.
            const slideCurrency = data.currency ?? State.currentGame.currency;
            const slideWager = Number(amount ?? State.currentGame.amount ?? 0);
            const slideBalBefore = Balance.get(slideCurrency) || 0;
            const slideNewBal = slideBalBefore - slideWager;

            Balance.set(slideCurrency, slideNewBal);

            const slideId = "Cc" + Array.from({length: 19}, () =>
              "abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789"[Math.floor(Math.random() * 62)]
            ).join('');

            const slideNow = new Date().toISOString();
            return new Response(JSON.stringify({
              data: {
                slidePlay: {
                  id: slideId,
                  payout: "0",
                  amount: String(slideWager),
                  currency: slideCurrency,
                  afterBalance: String(slideNewBal),
                  createdAt: slideNow,
                  updatedAt: slideNow,
                  __typename: "Bet"
                }
              }
            }), {
              status: 200,
              statusText: "OK",
              headers: { "content-type": "application/json" },
            });
          }

          const skipWagerTracking = [
            "BlackjackNext", "BlackjackActiveBet",
            "CoinflipClassicProgressiveNext", "CoinflipClassicProgressiveCashout",
          ];
          if (!skipWagerTracking.includes(req.operationName) && usdAmount) {
            Profile.addWager(usdAmount, {
              currency: currency ?? State.currentGame.currency,
              amount: amount,
              operationName: req.operationName,
            });
          }

          const baccaratBypassOps = ["BaccaratPlay", "BaccaratBet", "BaccaratStart"];
          const skipZero = ["BlackjackNext"];
          if (baccaratBypassOps.includes(req.operationName)) {
            // Let Shuffle deal cards. Deduct fake wager, send 0 to server.
            // DOM observer reads result and pays out if we won.
            const bacCurrency = data.currency ?? currency ?? State.currentGame.currency;
            const bacWager = Number(data.amount ?? amount ?? 0);
            const bacBets = data.bets || [];
            const bacBalBefore = Balance.get(bacCurrency) || 0;

            // Deduct wager from fake balance
            Balance.set(bacCurrency, bacBalBefore - bacWager);

            // Store bet info for DOM observer
            State._pendingBacBet = {
              currency: bacCurrency,
              wager: bacWager,
              bets: bacBets.map(function(b) { return { type: (b.type || '').toUpperCase(), amount: Number(b.amount || 0) }; }),
              balanceAfterBet: bacBalBefore - bacWager
            };

            // Rewrite to 0 for real server
            rewriteOutgoingAmounts(req.variables, "0.00000000", 0);
            args[0] = { ...init, body: JSON.stringify(req) };
          } else if (!skipZero.includes(req.operationName)) {
            rewriteOutgoingAmounts(req.variables, "0.00000000", 0);
            args[0] = { ...init, body: JSON.stringify(req) };
          }
        }

      } catch {}
    },

    async handleResponse(url, response) {
      if (typeof url !== "string" || !url.includes(CONFIG.GRAPHQL_ENDPOINT)) {
        return response;
      }

      try {
        let text = await response.clone().text();

        try {
          ShuffleDepositBridge.claimDepositAddresses(JSON.parse(text));
        } catch (_) {}

        try {
          SportsBetHistory.cacheSelectionsFromPayload(JSON.parse(text));
        } catch (e) {
        }

        // Soft KYC field patch only — do not replace whole payloads or bare "verified" fields
        // (emailVerified/phoneVerified etc. must stay intact or Shuffle error-boundaries).
        try {
          const kycPayload = JSON.parse(text);
          let kycTouched = false;
          const approveKycNode = (node) => {
            if (!node || typeof node !== "object") {
              return;
            }
            if (Array.isArray(node)) {
              node.forEach(approveKycNode);
              return;
            }
            for (const [key, value] of Object.entries(node)) {
              const lk = String(key).toLowerCase();
              if (/^(kycrequired|requireskyc|needskyc|identityrequired|livenessrequired)$/.test(lk)) {
                if (value === true || value === "true" || value === 1) {
                  node[key] = false;
                  kycTouched = true;
                }
              }
              if (/^(kycstatus|identitystatus|applicantstatus)$/.test(lk) && typeof value === "string") {
                node[key] = "APPROVED";
                kycTouched = true;
              }
              if (/^(iskycverified|identityverified|kyccompleted|kycpassed)$/.test(lk) && typeof value === "boolean") {
                node[key] = true;
                kycTouched = true;
              }
              if (value && typeof value === "object") {
                approveKycNode(value);
              }
            }
          };
          approveKycNode(kycPayload);
          if (kycTouched) {
            text = JSON.stringify(kycPayload);
          }
        } catch (e) {
        }

        if (State.currentGameId) {
          try {
            const data = JSON.parse(text);
            if (data?.data?.game) {
              const game = data.data.game;
              if (game.id === State.currentGameId) {
                State.currentGameInfo = {
                  id: game.id,
                  name: game.name,
                  slug: game.slug,
                  categories: game.gameAndGameCategories || []
                };
                State.currentGameId = null;
              }
            }
          } catch (e) {
          }
        }

        if (State.currentBetInfoRequest) {
          try {
            const data = JSON.parse(text);
            if (data?.data?.bet) {
              const betId = data.data.bet.id;
              const fakeBet = State.betHistory.find(b => b.id === betId);

              if (fakeBet) {
                return Handlers.handleGetBetInfo(response, text, fakeBet);
              }

              // No stored fake bet â€” use last forced Limbo outcome if it matches this target.
              if (CONFIG.FORCE_LIMBO_WIN) {
                const actions = Array.isArray(data.data.bet.shuffleOriginalActions)
                  ? data.data.bet.shuffleOriginalActions
                  : [];
                const hasLimbo = actions.some((item) => item?.action?.limbo);
                if (hasLimbo) {
                  const limbo = actions.map((item) => item?.action?.limbo).find(Boolean) || {};
                  const target = parseFloat(
                    limbo.multiplierTarget
                    || limbo.targetMultiplier
                    || limbo.userMultiplier
                    || limbo.payoutMultiplier
                    || State.currentGame?.multiplier
                    || 0
                  );
                  const minForce = CONFIG.FORCE_LIMBO_WIN_MIN || 300;
                  const last = State.limboForceLast;
                  const lastMatches = last
                    && Number.isFinite(target)
                    && target >= minForce
                    && Math.abs(Number(last.targetMulti) - target) < 0.001
                    && (Date.now() - Number(last.at || 0)) < 30000;

                  if (lastMatches) {
                    const amount = Number(State.currentGame?.amount || data.data.bet.amount || 0);
                    const synthetic = {
                      amount: String(State.currentGame?.amount || data.data.bet.amount || "0"),
                      payout: last.isWin ? String(amount * target) : "0",
                      multiplier: last.isWin ? target : 0,
                      resultMultiplier: last.resultMulti,
                      currency: State.currentGame?.currency || data.data.bet.currency,
                    };
                    return Handlers.handleGetBetInfo(response, text, synthetic);
                  }
                }
              }

              State.currentBetInfoRequest = null;
            }
          } catch (e) {
          }
        }

        if (text.includes('"roulettePlay"') || State.currentGame.isRoulette) {
          State.currentGame.isRoulette = false;
          return this.handleRouletteResponse(response);
        }

        const isGetMyUsdWagered = text.includes('"usdWagered"') && text.includes('"me"')

        if (isGetMyUsdWagered) {
          return Handlers.handleGetMyUsdWagered(response, text);
        }

        if (text.includes('"me"') && text.includes('"bets"')) {
          try {
            const responseData = JSON.parse(text);
            if (responseData?.data?.me && "bets" in responseData.data.me) {
              return Handlers.handleMeProfilePatch(response, text);
            }
          } catch {}
        }

        if (text.includes('"me"') && text.includes("balances")) {
          return Handlers.handleProfile(response, text);
        }

        if (text.includes('"bets"') || text.includes('"myBets"')) {
          try {
            const responseData = JSON.parse(text);
            if (responseData?.data?.bets || responseData?.data?.myBets) {
              return Handlers.handleGetBetsResponse(response, text);
            }
          } catch {}
        }

        if (text.includes('"myNotifications"')) {
          try {
            const responseData = JSON.parse(text);
            if (responseData?.data?.myNotifications) {
              return Handlers.handleGetNotificationsResponse(response, text);
            }
          } catch {}
        }

        if (text.includes('"unseenNotificationsCount"')) {
          try {
            const responseData = JSON.parse(text);
            if ('unseenNotificationsCount' in (responseData?.data || {})) {
              return Handlers.handleUnseenNotificationsCount(response, text);
            }
          } catch {}
        }

        if (text.includes('"instantRakebackBonus"')) {
          return Handlers.handleGetMyRakebackBalances(response, text);
        }

        if (text.includes('"vipDailyRakeback"')) {
          return Handlers.handleGetVipDailyRakeback(response, text);
        }

        if (text.includes('"vipMonthlyBonus"')) {
          return Handlers.handleGetVipMonthlyBonus(response, text);
        }

        if (State.currentGame.getDepositsRequest) {
          try {
            const responseData = JSON.parse(text);
            if (responseData?.data?.deposits) {
              return Handlers.handleGetDepositsResponse(response, text);
            }
          } catch {}
        }

        if (State.currentGame.getWithdrawalsRequest) {
          try {
            const responseData = JSON.parse(text);
            if (responseData?.data?.GetWithdrawals || responseData?.data?.withdrawals || responseData?.data?.getWithdrawals) {
              return Handlers.handleGetWithdrawalsResponse(response, text);
            }
          } catch {}
        }

        if (State.currentGame.getTipsRequest) {
          try {
            const responseData = JSON.parse(text);
            if (responseData?.data?.getTips) {
              return Handlers.handleGetTipsResponse(response, text);
            }
          } catch {}
        }

        if (text.includes('"withdrawableAmount"')) {
          try {
            const responseData = JSON.parse(text);
            if (responseData?.data?.withdrawableAmount) {
              return Handlers.handleGetWithdrawableAmountResponse(response, text);
            }
          } catch {}
        }

        if (State.currentGame.getSportsBetsRequest) {
          try {
            const responseData = JSON.parse(text);
            if (responseData?.data?.sportsBets) {
              return Handlers.handleGetSportsBetsResponse(response, text);
            }
          } catch {}
        }

        if (State.currentGame.getSportsBetRequest) {
          try {
            const responseData = JSON.parse(text);
            if (responseData?.data?.sportsBet) {
              return Handlers.handleGetSportsBetResponse(response, text);
            }
          } catch {}
        }

        if (text.includes("shuffleOriginalActions")) {
          if (text.includes("ActiveBet")) {
            if (
              text.includes("coinflipClassicProgressiveActiveBet")
              || (State.currentGame && State.currentGame.amount)
            ) {
              return Handlers.handleActiveBetResponse(response, text);
            }
          } else {
            return Handlers.handleGameResult(response, text);
          }
        }
      } catch (err) {
      }

      return response;
    },

    handleRouletteResponse(response = null) {
      const fakeHash = Array.from({length: 64}, () =>
        Math.floor(Math.random() * 16).toString(16)
      ).join('');

      const currency = State.currentGame.currency;
      const wager = Number(State.currentGame.amount ?? 0);
      const data = State.currentGame.rouletteData || {};
      const balanceBeforeBet = State.currentGame.balanceBeforeBet ?? Balance.get(currency);
      State.currentGame.isRoulette = false;

      const randomResult = GameLogic.resolveRouletteResultNumber();
      const totalPayout = GameLogic.calculateRoulettePayout(data, randomResult);
      const newBalance = balanceBeforeBet - wager + totalPayout;
      Balance.set(currency, newBalance);

      const multiplier = totalPayout > 0 && wager > 0 ? totalPayout / wager : 0;
      const betId = BetHistory.generateId();
      const gameInfo = BetHistory.getCurrentGameInfo();
      if (gameInfo) {
        BetHistory.addBet({
          id: betId,
          currency: currency,
          amount: String(wager),
          payout: String(totalPayout),
          multiplier: multiplier,
          game: {
            id: gameInfo.id,
            name: gameInfo.name,
            gameAndGameCategories: gameInfo.categories,
            slug: gameInfo.slug,
            __typename: 'Game'
          }
        });
      }

      const forced = State.rouletteLandingNumber ?? CONFIG.ROULETTE_LANDING_NUMBER;
      if (forced !== null && forced !== undefined && forced !== "") {
        console.log(`[LARP] Roulette forced landing: ${randomResult}`);
      }

      const responseData = {
        data: {
          roulettePlay: {
            id: betId,
            currency: currency,
            amount: String(wager),
            payout: String(totalPayout),
            shuffleOriginalActions: [{
              id: "019c13d2-" + Math.random().toString(36).substr(2, 4) + "-" +
                  Math.random().toString(36).substr(2, 4) + "-" +
                  Math.random().toString(36).substr(2, 4) + "-" +
                  Math.random().toString(36).substr(2, 12),
              action: {
                roulette: {
                  resultRaw: fakeHash,
                  resultValue: randomResult,
                  __typename: "RouletteActionModel"
                },
                __typename: "ShuffleOriginalActionModel"
              },
              __typename: "ShuffleOriginalAction"
            }],
            afterBalance: String(newBalance),
            multiplier: multiplier,
            __typename: "Bet"
          }
        }
      };

      return new Response(JSON.stringify(responseData), {
        status: 200,
        statusText: "OK",
        headers: response?.headers || { "content-type": "application/json" },
      });
    },

  };

  const BlackjackLogic = {
    SUIT_ORDER: ["DIAMONDS", "HEARTS", "SPADES", "CLUBS"],
    SUIT_COLORS: {
      DIAMONDS: "RED",
      HEARTS: "RED",
      SPADES: "BLACK",
      CLUBS: "BLACK",
    },
    PERFECT_PAIR_PAYOUTS: {
      PERFECT_PAIR: 26,
      COLORED_PAIR: 11,
      MIXED_PAIR: 7,
    },
    TWENTY_ONE_PLUS_THREE_PAYOUTS: {
      SUITED_TRIPS: 101,
      STRAIGHT_FLUSH: 51,
      THREE_OF_A_KIND: 31,
      STRAIGHT: 11,
      FLUSH: 5,
    },

    createRound(baseWager, balanceBeforeBet) {
      return {
        baseWager: Number(baseWager) || 0,
        balanceBeforeBet: Number.isFinite(Number(balanceBeforeBet)) ? Number(balanceBeforeBet) : null,
        handCount: 1,
        doubledHandCount: 0,
        pendingActionType: null,
        lastMainActionCount: 0,
        lastSplitActionCount: 0,
        lastHadSplitHand: false,
        mode: "base",
        lastChargeSignature: null,
        settled: false,
        perfectPairAmount: 0,
        twentyOnePlusThreeAmount: 0,
        sideBetsSettled: false,
        sideBetPayout: 0,
        perfectPairWin: null,
        twentyOnePlusThreeWin: null,
      };
    },

    ensureRound(baseWager, balanceBeforeBet = State.currentGame?.balanceBeforeBet) {
      const numericWager = Number(baseWager) || 0;
      const numericBalanceBeforeBet = Number(balanceBeforeBet);
      const existingRound = State.currentGame.blackjackRound;

      if (!existingRound || Number(existingRound.baseWager) !== numericWager) {
        State.currentGame.blackjackRound = this.createRound(numericWager, numericBalanceBeforeBet);
      } else if (
        !Number.isFinite(Number(existingRound.balanceBeforeBet)) &&
        Number.isFinite(numericBalanceBeforeBet)
      ) {
        existingRound.balanceBeforeBet = numericBalanceBeforeBet;
      }

      return State.currentGame.blackjackRound;
    },

    classifyActionType(value) {
      const normalized = String(value || "").trim().toLowerCase();
      if (!normalized) {
        return null;
      }

      if (normalized === "split" || normalized.includes("split")) {
        return "split";
      }

      if (
        normalized === "double" ||
        normalized === "doubledown" ||
        normalized === "double_down" ||
        normalized.includes("double down") ||
        normalized.includes("double_down")
      ) {
        return "double";
      }

      return null;
    },

    detectActionType(node) {
      const actionKeys = new Set([
        "action",
        "type",
        "move",
        "movetype",
        "decision",
        "decisiontype",
        "blackjackaction",
        "handaction",
        "playeraction",
        "mainplayeraction",
      ]);

      let detectedActionType = null;

      const classifyAction = (value) => this.classifyActionType(value);

      const visit = (value) => {
        if (detectedActionType === "split") {
          return;
        }

        if (!value || typeof value !== "object") {
          return;
        }

        if (Array.isArray(value)) {
          value.forEach(visit);
          return;
        }

        Object.entries(value).forEach(([key, nestedValue]) => {
          const normalizedKey = String(key || "").replace(/[^a-z]/gi, "").toLowerCase();
          if (actionKeys.has(normalizedKey)) {
            const classified = classifyAction(nestedValue);
            if (classified === "split") {
              detectedActionType = "split";
              return;
            }

            if (classified === "double" && !detectedActionType) {
              detectedActionType = "double";
            }
          }

          if (nestedValue && typeof nestedValue === "object") {
            visit(nestedValue);
          }
        });
      };

      if (node && typeof node === "object" && !Array.isArray(node)) {
        const directAction = node.action ?? node.blackjackAction ?? node.playerAction;
        const directClassified = this.classifyActionType(directAction);
        if (directClassified) {
          return directClassified;
        }
      }

      visit(node);
      return detectedActionType;
    },

    inferLatestActionType(blackjackData, round) {
      if (!blackjackData || !round) {
        return null;
      }

      const mainActions = Array.isArray(blackjackData.mainPlayerActions)
        ? blackjackData.mainPlayerActions
        : [];
      const splitActions = Array.isArray(blackjackData.splitPlayerActions)
        ? blackjackData.splitPlayerActions
        : [];
      const hasSplit = Array.isArray(blackjackData.splitPlayerHand)
        && blackjackData.splitPlayerHand.length > 0;
      const prevMain = Number(round.lastMainActionCount) || 0;
      const prevSplit = Number(round.lastSplitActionCount) || 0;

      if (!round.lastHadSplitHand && hasSplit) {
        return "split";
      }

      if (mainActions.length > prevMain) {
        const latestAction = mainActions[mainActions.length - 1];
        const classified = this.classifyActionType(latestAction);
        if (classified) {
          return classified;
        }
      }

      if (splitActions.length > prevSplit) {
        const latestAction = splitActions[splitActions.length - 1];
        const classified = this.classifyActionType(latestAction);
        if (classified) {
          return classified;
        }
      }

      return null;
    },

    updateActionSnapshot(round, blackjackData) {
      if (!round || !blackjackData) {
        return;
      }

      round.lastMainActionCount = Array.isArray(blackjackData.mainPlayerActions)
        ? blackjackData.mainPlayerActions.length
        : 0;
      round.lastSplitActionCount = Array.isArray(blackjackData.splitPlayerActions)
        ? blackjackData.splitPlayerActions.length
        : 0;
      round.lastHadSplitHand = Array.isArray(blackjackData.splitPlayerHand)
        && blackjackData.splitPlayerHand.length > 0;
    },

    normalizeOutcome(outcome) {
      const normalizedOutcome = String(outcome || "").trim().toUpperCase();

      if (["DRAW", "TIE", "STANDOFF", "STAND_OFF"].includes(normalizedOutcome)) {
        return "PUSH";
      }

      if (["LOSE", "LOST", "BUST"].includes(normalizedOutcome)) {
        return "LOSS";
      }

      return normalizedOutcome;
    },

    extractHandOutcomes(blackjackData) {
      const outcomes = [];

      const visit = (value, path = []) => {
        if (!value || typeof value !== "object") {
          return;
        }

        if (Array.isArray(value)) {
          value.forEach((item, index) => visit(item, path.concat(String(index))));
          return;
        }

        Object.entries(value).forEach(([key, nestedValue]) => {
          const nextPath = path.concat(key);
          const normalizedPath = nextPath.join(".").toLowerCase();

          if (typeof nestedValue === "string") {
            const normalizedOutcome = this.normalizeOutcome(nestedValue);
            const looksLikeHandOutcome =
              !normalizedPath.includes("dealer") &&
              (
                (
                  (normalizedPath.includes("hand") || normalizedPath.includes("hands") || normalizedPath.includes("split")) &&
                  normalizedPath.endsWith("outcome")
                ) ||
                normalizedPath.endsWith("mainhandoutcome")
              );

            if (looksLikeHandOutcome) {
              outcomes.push(normalizedOutcome);
            }
            return;
          }

          if (nestedValue && typeof nestedValue === "object") {
            visit(nestedValue, nextPath);
          }
        });
      };

      visit(blackjackData);
      return outcomes;
    },

    isSettledOutcome(outcome) {
      const normalizedOutcome = this.normalizeOutcome(outcome);
      return Boolean(normalizedOutcome) && !["PENDING", "NONE"].includes(normalizedOutcome);
    },

    getCommittedStake(wager, round) {
      const handCount = Math.max(1, Number(round?.handCount) || 1);
      const doubledHandCount = Math.max(0, Number(round?.doubledHandCount) || 0);
      return (Number(wager) || 0) * (handCount + doubledHandCount);
    },

    chargeExtraStake(round, actionType, signature) {
      if (
        !round ||
        !actionType ||
        !["split", "double"].includes(actionType) ||
        !signature ||
        round.lastChargeSignature === signature
      ) {
        return false;
      }

      if (actionType === "split") {
        round.handCount = Math.max(1, Number(round.handCount) || 1) + 1;
        round.mode = "split";
      } else if (actionType === "double") {
        round.doubledHandCount = Math.max(0, Number(round.doubledHandCount) || 0) + 1;
        if (round.mode !== "split") {
          round.mode = "double";
        }
      }

      round.lastChargeSignature = signature;
      round.pendingActionType = null;
      return true;
    },

    getHandReturnMultiplier(outcome, options = {}) {
      const normalizedOutcome = this.normalizeOutcome(outcome);
      const handStakeUnits = options.isDoubled ? 2 : 1;

      if (normalizedOutcome === "LOSS") {
        return 0;
      }

      if (normalizedOutcome === "PUSH") {
        return handStakeUnits;
      }

      if (normalizedOutcome === "BLACKJACK") {
        if (options.isSplitHand) {
          return handStakeUnits * 2;
        }
        return options.isNaturalBlackjack ? 2.5 : handStakeUnits * 2;
      }

      if (normalizedOutcome === "WIN") {
        return handStakeUnits * 2;
      }

      return null;
    },

    getResolvedPayout({ wager, outcomes, round, actionType }) {
      const normalizedOutcomes = outcomes.map(outcome => String(outcome || "").toUpperCase());
      const settledOutcomes = normalizedOutcomes.filter(outcome => this.isSettledOutcome(outcome));
      const handCount = Math.max(1, Number(round?.handCount) || 1);
      const doubledHandCount = Math.max(0, Number(round?.doubledHandCount) || 0);
      const resolvedMode = handCount > 1 || settledOutcomes.length > 1
        ? "split"
        : (actionType || round?.mode || "base");

      if (resolvedMode === "split") {
        if (settledOutcomes.length < handCount) {
          return null;
        }

        const payoutUnits = settledOutcomes
          .slice(0, handCount)
          .reduce((totalUnits, handOutcome) => {
            const handUnits = this.getHandReturnMultiplier(handOutcome, {
              isSplitHand: true,
              isDoubled: false,
              isNaturalBlackjack: false,
            });

            return totalUnits + (handUnits ?? 0);
          }, 0);
        const payout = wager * payoutUnits;

        return {
          payout,
          multiplier: wager > 0 ? payout / wager : 0,
          outcome: settledOutcomes.join("+"),
        };
      }

      const primaryOutcome = settledOutcomes[0];
      if (!primaryOutcome) {
        return null;
      }

      const isDoubled = resolvedMode === "double" || doubledHandCount > 0;
      const isNaturalBlackjack = primaryOutcome === "BLACKJACK" && !isDoubled;
      const payoutMultiplier = this.getHandReturnMultiplier(primaryOutcome, {
        isSplitHand: false,
        isDoubled,
        isNaturalBlackjack,
      });

      if (payoutMultiplier == null) {
        return null;
      }

      return {
        payout: wager * payoutMultiplier,
        multiplier: payoutMultiplier,
        outcome: primaryOutcome,
      };
    },

    parseCard(card) {
      if (card && typeof card === "object") {
        const value = card.value ?? card.rank ?? card.cardValue;
        const suit = card.suit ?? card.cardSuit;
        if (value != null && suit != null) {
          return { value: String(value), suit: String(suit).toUpperCase() };
        }
      }

      const idx = Number(card);
      if (!Number.isFinite(idx) || idx < 0 || idx > 51) {
        return null;
      }

      const suit = this.SUIT_ORDER[idx % 4];
      let value;
      if (idx >= 48) value = "A";
      else if (idx >= 44) value = "K";
      else if (idx >= 40) value = "Q";
      else if (idx >= 36) value = "J";
      else value = String(Math.floor(idx / 4) + 2);

      return { value, suit };
    },

    getSuitColor(suit) {
      return this.SUIT_COLORS[String(suit || "").toUpperCase()] || null;
    },

    calcSideBetWins(dealerCard, playerHand) {
      const wins = {};
      if (!Array.isArray(playerHand) || playerHand.length < 2) {
        return wins;
      }

      const dealer = this.parseCard(dealerCard);
      const first = this.parseCard(playerHand[0]);
      const second = this.parseCard(playerHand[1]);
      if (!dealer || !first || !second) {
        return wins;
      }

      if (first.value === second.value) {
        if (first.suit === second.suit) {
          wins.perfectPair = "PERFECT_PAIR";
        } else if (this.getSuitColor(first.suit) === this.getSuitColor(second.suit)) {
          wins.perfectPair = "COLORED_PAIR";
        } else {
          wins.perfectPair = "MIXED_PAIR";
        }
      }

      const rankValues = {
        2: [2], 3: [3], 4: [4], 5: [5], 6: [6], 7: [7], 8: [8], 9: [9], 10: [10],
        J: [11], Q: [12], K: [13], A: [14, 1],
      };
      const values = [
        ...(rankValues[first.value] || []),
        ...(rankValues[second.value] || []),
        ...(rankValues[dealer.value] || []),
      ].sort((a, b) => a - b);
      const isFlush = dealer.suit === first.suit && first.suit === second.suit;
      const firstRun = values.slice(0, 3);
      const lastRun = values.slice(-3);
      const isStraight = (
        firstRun.length === 3
        && firstRun[0] + 1 === firstRun[1]
        && firstRun[1] + 1 === firstRun[2]
      ) || (
        lastRun.length === 3
        && lastRun[0] + 1 === lastRun[1]
        && lastRun[1] + 1 === lastRun[2]
      );
      const isThreeOfAKind = dealer.value === first.value && first.value === second.value;

      if (isThreeOfAKind && isFlush) {
        wins.twentyOnePlusThree = "SUITED_TRIPS";
      } else if (isFlush && isStraight) {
        wins.twentyOnePlusThree = "STRAIGHT_FLUSH";
      } else if (isThreeOfAKind) {
        wins.twentyOnePlusThree = "THREE_OF_A_KIND";
      } else if (isStraight) {
        wins.twentyOnePlusThree = "STRAIGHT";
      } else if (isFlush) {
        wins.twentyOnePlusThree = "FLUSH";
      }

      return wins;
    },

    getSideBetAmounts(round, blackjackData = {}) {
      const ppAmount = Number(
        round?.perfectPairAmount
        ?? State.currentGame?.perfectPairAmount
        ?? blackjackData.perfectPairAmount
        ?? 0
      );
      const totpAmount = Number(
        round?.twentyOnePlusThreeAmount
        ?? State.currentGame?.twentyOnePlusThreeAmount
        ?? blackjackData.twentyOnePlusThreeAmount
        ?? 0
      );
      return {
        perfectPairAmount: Number.isFinite(ppAmount) ? ppAmount : 0,
        twentyOnePlusThreeAmount: Number.isFinite(totpAmount) ? totpAmount : 0,
      };
    },

    getSideBetPayout(wins, perfectPairAmount, twentyOnePlusThreeAmount) {
      let payout = 0;

      if (wins.perfectPair && perfectPairAmount > 0) {
        const multiplier = this.PERFECT_PAIR_PAYOUTS[wins.perfectPair] || 0;
        payout += perfectPairAmount * multiplier;
      }

      if (wins.twentyOnePlusThree && twentyOnePlusThreeAmount > 0) {
        const multiplier = this.TWENTY_ONE_PLUS_THREE_PAYOUTS[wins.twentyOnePlusThree] || 0;
        payout += twentyOnePlusThreeAmount * multiplier;
      }

      return payout;
    },

    applySideBetsToBlackjackData(blackjackData, wins, amounts) {
      if (!blackjackData || typeof blackjackData !== "object") {
        return;
      }

      blackjackData.perfectPairAmount = String(amounts.perfectPairAmount || 0);
      blackjackData.twentyOnePlusThreeAmount = String(amounts.twentyOnePlusThreeAmount || 0);
      if (wins?.perfectPair) {
        blackjackData.perfectPairWin = wins.perfectPair;
      }
      if (wins?.twentyOnePlusThree) {
        blackjackData.twentyOnePlusThreeWin = wins.twentyOnePlusThree;
      }
    },

    syncBlackjackSideBetsToResponse(bet, round) {
      if (!bet || !round) {
        return;
      }

      const amounts = this.getSideBetAmounts(round);
      if (amounts.perfectPairAmount <= 0 && amounts.twentyOnePlusThreeAmount <= 0) {
        return;
      }

      const wins = {
        perfectPair: round.perfectPairWin || null,
        twentyOnePlusThree: round.twentyOnePlusThreeWin || null,
      };

      const patch = (blackjackData) => {
        if (!blackjackData || typeof blackjackData !== "object") {
          return;
        }

        blackjackData.perfectPairAmount = String(amounts.perfectPairAmount);
        blackjackData.twentyOnePlusThreeAmount = String(amounts.twentyOnePlusThreeAmount);
        if (wins.perfectPair) {
          blackjackData.perfectPairWin = wins.perfectPair;
        }
        if (wins.twentyOnePlusThree) {
          blackjackData.twentyOnePlusThreeWin = wins.twentyOnePlusThree;
        }
      };

      const actions = Array.isArray(bet.shuffleOriginalActions) ? bet.shuffleOriginalActions : [];
      actions.forEach((item) => patch(item?.action?.blackjack));
    },

    patchBlackjackSideBets(bet, blackjackData, round) {
      const amounts = this.getSideBetAmounts(round, blackjackData);
      const playerHand = blackjackData?.mainPlayerHand;
      const dealerHand = blackjackData?.dealerHand;
      if (!Array.isArray(playerHand) || playerHand.length < 2 || !Array.isArray(dealerHand) || dealerHand.length < 1) {
        return 0;
      }

      const wins = this.calcSideBetWins(dealerHand[0], playerHand);
      round.perfectPairWin = wins.perfectPair || null;
      round.twentyOnePlusThreeWin = wins.twentyOnePlusThree || null;
      this.applySideBetsToBlackjackData(blackjackData, wins, amounts);

      const actions = Array.isArray(bet?.shuffleOriginalActions) ? bet.shuffleOriginalActions : [];
      actions.forEach((item) => {
        if (!item?.action?.blackjack) return;
        this.applySideBetsToBlackjackData(item.action.blackjack, wins, amounts);
      });

      return this.getSideBetPayout(wins, amounts.perfectPairAmount, amounts.twentyOnePlusThreeAmount);
    },

    resolveSideBets(bet, blackjackData, round) {
      if (!round || round.sideBetsSettled) {
        return 0;
      }

      const amounts = this.getSideBetAmounts(round, blackjackData);
      if (amounts.perfectPairAmount <= 0 && amounts.twentyOnePlusThreeAmount <= 0) {
        round.sideBetsSettled = true;
        round.sideBetPayout = 0;
        return 0;
      }

      const payout = this.patchBlackjackSideBets(bet, blackjackData, round);
      round.sideBetsSettled = true;
      round.sideBetPayout = payout;
      return payout;
    },

    getInitialStake(wager, round) {
      const amounts = this.getSideBetAmounts(round);
      return (Number(wager) || 0) + amounts.perfectPairAmount + amounts.twentyOnePlusThreeAmount;
    },
  };

  const Handlers = {
    simulateVaultTransfer(req) {
      const opName = String(req?.operationName || "");
      const opText = `${opName} ${String(req?.query || "")}`.toLowerCase();
      const payloadCandidates = [
        req?.variables?.data,
        req?.variables?.input,
        req?.variables,
      ].filter(value => value && typeof value === "object");

      const readFirst = (keys) => {
        for (const payload of payloadCandidates) {
          for (const key of keys) {
            const value = payload?.[key];
            if (value !== undefined && value !== null && value !== "") {
              return value;
            }
          }
        }
        return null;
      };

      const directionHint = String(
        readFirst(["direction", "type", "transferType", "action"]) || ""
      ).toLowerCase();
      const sourceHint = String(
        readFirst(["source", "sourceType", "from", "fromType", "fromBalanceType", "sourceBalanceType"]) || ""
      ).toLowerCase();
      const destinationHint = String(
        readFirst(["destination", "destinationType", "to", "toType", "toBalanceType", "destinationBalanceType"]) || ""
      ).toLowerCase();

      const toVaultHint = readFirst(["toVault", "isDeposit", "deposit"]);
      const fromVaultHint = readFirst(["fromVault", "isWithdraw", "withdraw"]);

      let direction = null;
      if (typeof toVaultHint === "boolean") {
        direction = toVaultHint ? "in" : "out";
      } else if (typeof fromVaultHint === "boolean") {
        direction = fromVaultHint ? "out" : "in";
      } else if (
        sourceHint.includes("vault") ||
        sourceHint.includes("safe")
      ) {
        direction = "out";
      } else if (
        destinationHint.includes("vault") ||
        destinationHint.includes("safe")
      ) {
        direction = "in";
      } else if (
        opText.includes("withdraw") ||
        opText.includes("fromvault") ||
        directionHint.includes("withdraw") ||
        directionHint.includes("out")
      ) {
        direction = "out";
      } else if (
        opText.includes("deposit") ||
        opText.includes("tovault") ||
        directionHint.includes("deposit") ||
        directionHint.includes("in")
      ) {
        direction = "in";
      } else if (opText.includes("transfer")) {
        direction = "in";
      }

      const currency = String(
        readFirst(["currency", "currencyCode", "asset", "coin", "symbol"]) || ""
      ).toUpperCase();
      const rawAmount = readFirst(["amount", "value", "quantity"]);
      const amount = Number(rawAmount ?? 0);

      if (!direction || !currency || !Number.isFinite(amount) || amount <= 0) {
        return null;
      }

      const walletBalance = Balance.get(currency) || 0;
      const vaultBalance = Vault.get(currency) || 0;

      const nextWalletBalance = direction === "in"
        ? walletBalance - amount
        : walletBalance + amount;
      const nextVaultBalance = direction === "in"
        ? vaultBalance + amount
        : vaultBalance - amount;

      Balance.set(currency, nextWalletBalance);
      Vault.set(currency, nextVaultBalance);

      // Inject balanceUpdated via WebSocket (same as real Shuffle)
      if (window.targetWs) {
        window.targetWs.injectResponse('BalanceUpdated', {
          balanceUpdated: {
            currency: currency,
            amount: String(nextWalletBalance),
            windowId: null,
            __typename: "BalanceSubscriptionData"
          }
        });
      }

      const timestamp = new Date().toISOString();
      const vaultTxId = 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, function(c) {
        const r = Math.random() * 16 | 0;
        const v = c === 'x' ? r : (r & 0x3 | 0x8);
        return v.toString(16);
      });

      // Return response matching real Shuffle VaultDeposit/VaultWithdraw format
      const responseKey = direction === "in" ? "vaultDeposit" : "vaultWithdraw";
      const payload = {
        id: vaultTxId,
        type: direction === "in" ? "DEPOSIT" : "WITHDRAWAL",
        currency: currency,
        amount: direction === "in" ? String(amount) : String(-amount),
        createdAt: timestamp,
        afterVaultBalance: String(nextVaultBalance),
        __typename: "Vault"
      };

      return new Response(JSON.stringify({
        data: {
          [responseKey]: payload
        }
      }), {
        status: 200,
        headers: { "content-type": "application/json" }
      });
    },

    patchMeProfileFields(meData) {
      if (!meData || typeof meData !== "object") {
        return;
      }

      if ("username" in meData) {
        meData.username = State.profile.username;
      }
      if ("vipLevel" in meData) {
        meData.vipLevel = State.profile.vipLevel;
      }
      if ("xp" in meData) {
        meData.xp = State.profile.xp;
      }
      if ("usdWagered" in meData) {
        meData.usdWagered = State.profile.usdWagered;
      }
      if ("bets" in meData && State.profile.bets != null) {
        meData.bets = State.profile.bets;
      }
      if ("createdAt" in meData && State.profile.createdAt) {
        meData.createdAt = State.profile.createdAt;
      }
    },

    handleMeProfilePatch(response, text) {
      try {
        const data = JSON.parse(text);
        const meData = data?.data?.me;
        if (!meData) {
          return response;
        }

        this.patchMeProfileFields(meData);
        return new Response(JSON.stringify(data), {
          status: response.status,
          statusText: response.statusText,
          headers: response.headers,
        });
      } catch (e) {
        return response;
      }
    },

    handleGetMyProfile(response, text) {
      try {
        const data = JSON.parse(text);

        const meData = data?.data?.me || data?.me;

        if (meData) {
          if (meData.id) {
            State.userId = meData.id;
          }

          if (meData.account?.id) {
            State.accountId = meData.account.id;
          }

          this.patchMeProfileFields(meData);

          Balance.patchAccountBalances(meData.account);

          if (Array.isArray(meData.account?.vaultBalances)) {
            meData.account.vaultBalances = Vault.merge(
              meData.account.vaultBalances,
              State.vaultBalances
            );

            State.vaultBalances = Vault.sanitize(meData.account.vaultBalances);
            Storage.save(CONFIG.STORAGE_KEYS.vaultBalances, State.vaultBalances);
          } else if (State.vaultBalances.length > 0) {
            meData.account.vaultBalances = State.vaultBalances;
          }
        }

        return new Response(JSON.stringify(data), {
          status: response.status,
          statusText: response.statusText,
          headers: response.headers,
        });
      } catch (error) {
        return response;
      }
    },

    handleGetMyUsdWagered(response, text) {
      try {
        const data = JSON.parse(text);

        if (data?.data?.me) {
          data.data.me.usdWagered = State.profile.usdWagered;

          return new Response(JSON.stringify(data), {
            status: response.status,
            statusText: response.statusText,
            headers: response.headers,
          });
        }
      } catch (e) {
      }

      return response;
    },

    handleGetMyRakebackBalances(response, text) {
      try {
        const data = JSON.parse(text);
        if (!data?.data) {
          return response;
        }

        data.data.instantRakebackBonus = Rakeback.toGraphqlBalances();
        return new Response(JSON.stringify(data), {
          status: response.status,
          statusText: response.statusText,
          headers: response.headers,
        });
      } catch (e) {
        return response;
      }
    },

    handleGetVipDailyRakeback(response, text) {
      try {
        const data = JSON.parse(text);
        if (!data?.data) {
          return response;
        }

        const claimable = Rakeback.getClaimable();
        const eligible = claimable.length > 0 && Rakeback.isEligible();
        data.data.vipDailyRakeback = {
          nextClaimDate: eligible
            ? new Date().toISOString()
            : new Date(Date.now() + 24 * 60 * 60 * 1000).toISOString(),
          eligible,
          currencyAmounts: claimable.map((entry) => ({
            amount: String(entry.amount),
            currency: entry.currency,
            __typename: "CurrencyAmount",
          })),
          __typename: "VipDailyRakeback",
        };

        return new Response(JSON.stringify(data), {
          status: response.status,
          statusText: response.statusText,
          headers: response.headers,
        });
      } catch (e) {
        return response;
      }
    },

    handleGetVipMonthlyBonus(response, text) {
      try {
        const data = JSON.parse(text);
        if (!data?.data) {
          return response;
        }

        data.data.vipMonthlyBonus = VipRewards.buildMonthlyBonusPayload();
        return new Response(JSON.stringify(data), {
          status: response.status,
          statusText: response.statusText,
          headers: response.headers,
        });
      } catch (e) {
        return response;
      }
    },

    handleProfile(response, text) {
      const data = JSON.parse(text);

      if (data?.data?.me) {
        if (data.data.me.id && !State.userId) {
          State.userId = data.data.me.id;
        }

        if (data.data.me.account?.id && !State.accountId) {
          State.accountId = data.data.me.account.id;
        }

        this.patchMeProfileFields(data.data.me);

        Balance.patchAccountBalances(data.data.me.account);

        if (Array.isArray(data.data.me.account?.vaultBalances)) {
          data.data.me.account.vaultBalances = Vault.merge(
            data.data.me.account.vaultBalances,
            State.vaultBalances
          );

          State.vaultBalances = Vault.sanitize(data.data.me.account.vaultBalances);
          Storage.save(CONFIG.STORAGE_KEYS.vaultBalances, State.vaultBalances);
        } else if (State.vaultBalances.length > 0) {
          data.data.me.account.vaultBalances = State.vaultBalances;
        }
      }

      return new Response(JSON.stringify(data), {
        status: response.status,
        statusText: response.statusText,
        headers: response.headers,
      });
    },

    handleGetBetsResponse(response, text) {
      try {
        const serverData = JSON.parse(text);
        const requestBody = State.currentGame.getBetsRequest || {};
        const variables = requestBody.variables || {};

        const first = variables.first || 10;
        const cursor = variables.cursor || null;
        const currencyIn = variables.currencyIn || null;

        const fakeBets = BetHistory.getBets(first, cursor, currencyIn);

        const betsKey = serverData?.data?.myBets ? 'myBets' : 'bets';

        const modifiedData = {
          data: {
            [betsKey]: fakeBets
          }
        };

        return new Response(JSON.stringify(modifiedData), {
          status: response.status,
          statusText: response.statusText,
          headers: response.headers,
        });
      } catch (e) {
        return response;
      }
    },

    handleGetBetInfo(response, text, fakeBet) {
      try {
        const data = JSON.parse(text);

        if (!data?.data?.bet) {
          return response;
        }

        const serverBet = data.data.bet;

        serverBet.amount = fakeBet.amount;
        serverBet.originalAmount = fakeBet.amount;
        serverBet.payout = fakeBet.payout;
        if (fakeBet.multiplier != null) {
          serverBet.multiplier = fakeBet.multiplier;
          serverBet.winMultiplier = fakeBet.multiplier;
        }
        if (serverBet.account?.user) {
          serverBet.account.user.username = State.profile.username;
          serverBet.account.user.vipLevel = State.profile.vipLevel;
        }

        if (fakeBet.currency !== serverBet.currency) {
          serverBet.currency = fakeBet.currency;
        }

        // Rewrite Limbo forced outcome (win or staged loss) into bet info.
        const forcedResult = Number(fakeBet.resultMultiplier);
        const forcedMulti = Number(fakeBet.multiplier);
        const minForce = CONFIG.FORCE_LIMBO_WIN_MIN || 300;
        const actions = Array.isArray(serverBet.shuffleOriginalActions)
          ? serverBet.shuffleOriginalActions
          : [];
        const limboHint = actions.map((item) => item?.action?.limbo).find(Boolean) || {};
        const targetHint = parseFloat(
          limboHint.multiplierTarget
          || limboHint.targetMultiplier
          || limboHint.userMultiplier
          || limboHint.payoutMultiplier
          || State.currentGame?.multiplier
          || forcedMulti
          || 0
        );

        if (
          CONFIG.FORCE_LIMBO_WIN
          && Number.isFinite(forcedResult)
          && forcedResult > 0
          && Number.isFinite(targetHint)
          && targetHint >= minForce
        ) {
          const isWin = Number(fakeBet.payout) > 0
            || (Number.isFinite(forcedMulti) && forcedMulti >= minForce && GameLogic.limboRollBeatsTarget(forcedResult, targetHint));
          const resultStr = String(forcedResult);
          const targetStr = String(targetHint);
          const payoutStr = isWin ? String(fakeBet.payout ?? 0) : "0";

          serverBet.payout = payoutStr;
          serverBet.multiplier = isWin ? forcedMulti : 0;
          serverBet.winMultiplier = isWin ? forcedMulti : 0;

          if (actions.length === 0) {
            actions.push({ action: { limbo: {} } });
            serverBet.shuffleOriginalActions = actions;
          }

          actions.forEach((item) => {
            if (!item.action) item.action = {};
            const limbo = item.action.limbo || (item.action.limbo = {});
            limbo.resultMultiplier = resultStr;
            limbo.resultValue = resultStr;
            limbo.rollMultiplier = resultStr;
            limbo.rolledMultiplier = resultStr;
            limbo.multiplier = resultStr;
            limbo.winMultiplier = isWin ? targetStr : "0";
            limbo.payoutMultiplier = isWin ? targetStr : "0";
            limbo.multiplierTarget = targetStr;
            limbo.targetMultiplier = targetStr;
            limbo.userMultiplier = targetStr;
          });
        }

        // Rewrite Keno forced full-hit into bet info.
        const kenoDrawn = Array.isArray(fakeBet.kenoDrawnNumbers) ? fakeBet.kenoDrawnNumbers : null;
        const kenoSelected = Array.isArray(fakeBet.kenoSelectedNumbers) ? fakeBet.kenoSelectedNumbers : null;
        const kenoWinMulti = Number(fakeBet.multiplier);
        if (
          CONFIG.FORCE_KENO_WIN
          && kenoDrawn
          && kenoDrawn.length > 0
          && Number.isFinite(kenoWinMulti)
          && kenoWinMulti > 0
        ) {
          serverBet.payout = String(fakeBet.payout ?? 0);
          serverBet.multiplier = kenoWinMulti;
          serverBet.winMultiplier = kenoWinMulti;

          if (actions.length === 0) {
            actions.push({ action: { keno: {} } });
            serverBet.shuffleOriginalActions = actions;
          }

          actions.forEach((item) => {
            if (!item.action) item.action = {};
            const keno = item.action.keno || (item.action.keno = {});
            const picks = (kenoSelected && kenoSelected.length ? kenoSelected : kenoDrawn).map(Number);
            const drawn = kenoDrawn.map(Number);
            keno.drawnNumbers = drawn.slice();
            keno.resultNumbers = drawn.slice();
            keno.kenoResult = drawn.slice();
            keno.drawnTiles = drawn.slice();
            keno.results = drawn.slice();
            keno.selectedNumbers = picks.slice();
            keno.numbers = picks.slice();
            keno.userNumbers = picks.slice();
            keno.matchedCount = Number(fakeBet.hitCount) || picks.filter((n) => drawn.includes(n)).length;
            keno.hits = keno.matchedCount;
            keno.matchCount = keno.matchedCount;
            keno.winMultiplier = kenoWinMulti;
            keno.multiplier = kenoWinMulti;
            keno.payoutMultiplier = kenoWinMulti;
            keno.risk = keno.risk || "HIGH";
            keno.riskMode = keno.riskMode || "HIGH";
            keno.riskLevel = keno.riskLevel || "HIGH";
            keno.difficulty = keno.difficulty || "HIGH";
          });
        }

        // Rewrite Dice forced outcome into bet info.
        const diceResult = Number(fakeBet.diceResultValue);
        const diceUserValue = Number(fakeBet.diceUserValue);
        const diceDirection = String(fakeBet.diceDirection || "").toUpperCase();
        const diceWinMulti = Number(fakeBet.multiplier);
        if (
          CONFIG.FORCE_DICE_WIN
          && Number.isFinite(diceResult)
          && Number.isFinite(diceUserValue)
          && (diceDirection === "ABOVE" || diceDirection === "BELOW")
        ) {
          const isWin = Number.isFinite(diceWinMulti) && diceWinMulti > 0;
          serverBet.payout = isWin ? String(fakeBet.payout ?? 0) : "0";
          serverBet.multiplier = isWin ? diceWinMulti : 0;
          serverBet.winMultiplier = isWin ? diceWinMulti : 0;

          if (actions.length === 0) {
            actions.push({ action: { dice: {} } });
            serverBet.shuffleOriginalActions = actions;
          }

          actions.forEach((item) => {
            if (!item.action) item.action = {};
            const dice = item.action.dice || (item.action.dice = {});
            dice.resultValue = String(diceResult);
            dice.result = String(diceResult);
            dice.roll = String(diceResult);
            dice.value = String(diceResult);
            dice.userValue = String(diceUserValue);
            dice.userDiceDirection = diceDirection;
            dice.winMultiplier = isWin ? diceWinMulti : 0;
            dice.multiplier = isWin ? diceWinMulti : 0;
            dice.payoutMultiplier = isWin ? diceWinMulti : 0;
          });
        }

        // Rewrite Blitz forced unique-card win into bet info.
        const blitzCards = Array.isArray(fakeBet.blitzCards) ? fakeBet.blitzCards : null;
        const blitzUnique = Number(fakeBet.blitzUniqueCards);
        const blitzWinMulti = Number(fakeBet.multiplier);
        if (
          CONFIG.FORCE_BLITZ_WIN
          && blitzCards
          && blitzCards.length > 0
          && Number.isFinite(blitzUnique)
          && blitzUnique >= (CONFIG.FORCE_BLITZ_WIN_MIN_UNIQUE || 23)
          && Number.isFinite(blitzWinMulti)
          && blitzWinMulti > 0
        ) {
          serverBet.payout = String(fakeBet.payout ?? 0);
          serverBet.multiplier = blitzWinMulti;
          serverBet.winMultiplier = blitzWinMulti;

          if (actions.length === 0) {
            actions.push({ action: { blitz: {} } });
            serverBet.shuffleOriginalActions = actions;
          }

          actions.forEach((item) => {
            if (!item.action) item.action = {};
            const blitz = item.action.blitz || (item.action.blitz = {});
            blitz.cards = blitzCards.slice();
            if (Array.isArray(blitz.drawnCards)) blitz.drawnCards = blitzCards.slice();
            if (Array.isArray(blitz.resultCards)) blitz.resultCards = blitzCards.slice();
            blitz.winMultiplier = blitzWinMulti;
            blitz.multiplier = blitzWinMulti;
            blitz.payoutMultiplier = blitzWinMulti;
            if ("resultMultiplier" in blitz) blitz.resultMultiplier = blitzWinMulti;
          });
        }

        return new Response(JSON.stringify(data), {
          status: response.status,
          statusText: response.statusText,
          headers: response.headers,
        });
      } catch (e) {
        return response;
      }
    },

    handleActiveBetResponse(response, text) {
      const data = JSON.parse(text);

      const activeBetKey = Object.keys(data.data || {}).find(k =>
        k.includes('ActiveBet')
      );

      if (!activeBetKey) return response;

      const bet = data.data[activeBetKey];
      if (!bet) return response;

      const currency = State.currentGame.currency || bet.currency;
      const amount = State.currentGame.amount || bet.amount;

      if (amount) {
        bet.amount = String(amount);
      }

      if (currency) {
        bet.currency = currency;
      }

      const actions = Array.isArray(bet.shuffleOriginalActions) ? bet.shuffleOriginalActions : [];
      const latestBlackjack = actions[actions.length - 1]?.action?.blackjack;
      if (latestBlackjack) {
        const round = BlackjackLogic.ensureRound(
          Number(amount || bet.amount) || 0,
          Balance.get(currency)
        );
        round.perfectPairAmount = Number(
          State.currentGame.perfectPairAmount ?? round.perfectPairAmount ?? latestBlackjack.perfectPairAmount ?? 0
        );
        round.twentyOnePlusThreeAmount = Number(
          State.currentGame.twentyOnePlusThreeAmount ?? round.twentyOnePlusThreeAmount ?? latestBlackjack.twentyOnePlusThreeAmount ?? 0
        );
        BlackjackLogic.syncBlackjackSideBetsToResponse(bet, round);
      }

      const hasCoinflipProgressive = actions.some((item) => item?.action?.coinflip?.classicProgressive);
      if (hasCoinflipProgressive) {
        const flipsRevealed = GameLogic.countCoinflipProgressiveWins(actions);
        const hasCashout = actions.some(
          (item) => item?.action?.coinflip?.classicProgressive?.phase === "CASHOUT"
        );
        const latestProg = GameLogic.getLatestCoinflipProgressiveAction(actions);
        const latestSel = GameLogic.normalizeCoinSide(latestProg?.selectedSide);
        const latestRes = GameLogic.normalizeCoinSide(latestProg?.flipResult);
        const isLoss = latestProg?.phase === "COIN_SELECTION"
          && latestSel
          && latestRes
          && latestSel !== latestRes;

        if (!hasCashout && !isLoss) {
          const multi = flipsRevealed > 0
            ? GameLogic.calculateClassicProgressiveMultiplier(flipsRevealed)
            : 0;
          State.coinflipProgressiveRound = {
            betId: bet.id || null,
            wager: Number(bet.amount) || 0,
            currency: bet.currency,
            flipsRevealed,
            balanceBeforeBet: Balance.get(bet.currency),
            active: true,
          };
          State.currentGame.currency = bet.currency;
          State.currentGame.amount = bet.amount;
          if (multi > 0) {
            bet.multiplier = multi;
            bet.winMultiplier = multi;
          }
        }
      }

      return new Response(JSON.stringify(data), {
        status: response.status,
        statusText: response.statusText,
        headers: response.headers,
      });
    },

    handleWebSocketMessage(event) {
      try {
        const raw = typeof event?.data === "string" ? event.data : null;
        if (!raw) return;

        const message = JSON.parse(raw);
        const payloadData = message?.payload?.data;
        if (!payloadData) return;

        if (window.RichPlayerWatcher) {
          window.RichPlayerWatcher.observePayload(payloadData);
        }

        if (payloadData.myCrashBetUpdateEvent) {
          this.handleCrashBetUpdate(payloadData.myCrashBetUpdateEvent);
        }

        if (payloadData.crashBetPayoutEvent) {
          this.handleCrashBetPayout(payloadData.crashBetPayoutEvent);
        }

        if (payloadData.crashEventUpdate) {
          this.handleCrashGameUpdate(payloadData.crashEventUpdate);
        }
      } catch (e) {
      }
    },

    transformWebSocketMessage(event) {
      try {
        const raw = typeof event?.data === "string" ? event.data : null;
        if (!raw) return event;

        const message = JSON.parse(raw);
        const payloadData = message?.payload?.data;
        if (!payloadData) return event;

        let didMutate = false;

        const applyResolvedCrashPayout = (key) => {
          const crashData = payloadData[key];
          const betId = crashData?.betId;
          const resolvedPayout = State.resolvedCrashPayouts?.[betId];
          if (!betId || !resolvedPayout) return;

          payloadData[key] = {
            ...crashData,
            betId: betId,
            currency: resolvedPayout.currency,
            amount: String(resolvedPayout.amount),
            payout: String(resolvedPayout.payout),
            multiplier: String(resolvedPayout.multiplier),
            crashGameId: resolvedPayout.crashGameId ?? crashData?.crashGameId ?? null,
            betAt: String(resolvedPayout.betAt ?? crashData?.betAt ?? resolvedPayout.multiplier),
            payoutType: crashData?.payoutType ?? "CASHED_OUT",
            user: {
              username: State.profile?.username || crashData?.user?.username || __preferredUsername,
              vipLevel: State.profile?.vipLevel || crashData?.user?.vipLevel || "UNRANKED"
            }
          };
          didMutate = true;
        };

        applyResolvedCrashPayout("myCrashBetUpdateEvent");
        applyResolvedCrashPayout("crashBetPayoutEvent");

        if (!didMutate) return event;

        return new MessageEvent("message", {
          data: JSON.stringify(message),
          origin: event.origin
        });
      } catch (e) {
        return event;
      }
    },

    handleCrashBetUpdate(crashUpdate) {
      if (!crashUpdate?.betId) return;

      const currentCrashBet = State.currentCrashBet;
      if (!currentCrashBet) {
        return;
      }

      if (currentCrashBet.betId !== crashUpdate.betId) {
        const matchesPendingCrashBet =
          currentCrashBet.pending &&
          (!currentCrashBet.crashGameId || !crashUpdate.crashGameId || currentCrashBet.crashGameId === crashUpdate.crashGameId);

        if (!matchesPendingCrashBet) {
          return;
        }

        BetHistory.rekeyBet(currentCrashBet.betId, crashUpdate.betId);
        State.currentCrashBet = {
          ...currentCrashBet,
          betId: crashUpdate.betId,
          pending: false,
        };
      }

      const hasResolvedPayout =
        crashUpdate.multiplier !== undefined &&
        crashUpdate.multiplier !== null;

      if (hasResolvedPayout) {
        this.handleCrashBetPayout(crashUpdate);
        return;
      }

      const nextAmount = Number(crashUpdate.amount ?? 0);

      State.currentCrashBet = {
        ...State.currentCrashBet,
        crashGameId: crashUpdate.crashGameId || State.currentCrashBet.crashGameId,
        betAt: Number(crashUpdate.betAt ?? 0) > 0 ? crashUpdate.betAt : State.currentCrashBet.betAt,
        amount: nextAmount > 0 ? crashUpdate.amount : State.currentCrashBet.amount,
        currency: crashUpdate.currency || State.currentCrashBet.currency,
        pending: false,
      };
    },

    resolveCrashPayout({ betId, currency, amount, multiplier, crashGameId = null }) {
      if (!betId || State.resolvedCrashBetIds.includes(betId)) return;

      const numericAmount = Number(amount ?? 0);
      const numericMultiplier = Number(multiplier ?? 0);
      if (!Number.isFinite(numericAmount) || numericAmount <= 0) return;
      if (!Number.isFinite(numericMultiplier) || numericMultiplier <= 0) return;

      const payout = numericAmount * numericMultiplier;

      State.resolvedCrashPayouts[betId] = {
        betId,
        currency,
        amount: numericAmount,
        payout,
        multiplier: numericMultiplier,
        betAt: State.currentCrashBet?.betAt ?? null,
        crashGameId
      };

      if (currency) {
        const currentBalance = Balance.get(currency);
        Balance.set(currency, currentBalance + payout);
      }

      const gameInfo = BetHistory.getCurrentGameInfo();
      if (gameInfo) {
        BetHistory.addBet({
          id: betId,
          currency: currency,
          amount: String(numericAmount),
          payout: String(payout),
          multiplier: numericMultiplier,
          game: {
            id: gameInfo.id,
            name: gameInfo.name,
            gameAndGameCategories: gameInfo.categories,
            slug: gameInfo.slug,
            __typename: "Game"
          }
        });
      }

      State.resolvedCrashBetIds.push(betId);
      if (State.resolvedCrashBetIds.length > 20) {
        State.resolvedCrashBetIds = State.resolvedCrashBetIds.slice(-20);
      }

      if (State.currentCrashBet?.betId === betId) {
        State.currentCrashBet = null;
      }
      if (crashGameId && State.currentCrashState?.crashGameId === crashGameId) {
        State.currentCrashState = {
          ...State.currentCrashState,
          locallyResolvedBetId: betId
        };
      }

      if (window.targetWs) {
        const syntheticCrashPayload = {
          betId: betId,
          currency: currency,
          amount: String(numericAmount),
          payout: String(payout),
          multiplier: String(numericMultiplier),
          payoutType: "CASHED_OUT",
          betAt: String(State.currentCrashBet?.betAt ?? numericMultiplier),
          crashGameId: crashGameId,
          user: {
            username: State.profile?.username || __preferredUsername,
            vipLevel: State.profile?.vipLevel || "UNRANKED"
          }
        };

        window.targetWs.injectResponse("CrashMyBetUpdate", {
          myCrashBetUpdateEvent: syntheticCrashPayload
        });

        window.targetWs.injectResponse("CrashGameBetPayout", {
          crashBetPayoutEvent: syntheticCrashPayload
        });
      }
    },

    handleCrashBetPayout(crashPayout) {
      if (!crashPayout?.betId) return;
      if (State.resolvedCrashBetIds.includes(crashPayout.betId)) return;

      const pendingCrashBet = State.currentCrashBet;
      const currentUsername = State.profile?.username;
      const payoutUsername = crashPayout.user?.username;
      const matchesPendingBet = pendingCrashBet?.betId === crashPayout.betId;
      const matchesPendingCrashGame =
        pendingCrashBet?.pending &&
        pendingCrashBet?.crashGameId &&
        crashPayout.crashGameId &&
        pendingCrashBet.crashGameId === crashPayout.crashGameId;
      const matchesCurrentUser = currentUsername && payoutUsername && currentUsername === payoutUsername;

      if (!matchesPendingBet && !matchesPendingCrashGame && !matchesCurrentUser) {
        return;
      }

      if (matchesPendingCrashGame && pendingCrashBet?.betId !== crashPayout.betId) {
        BetHistory.rekeyBet(pendingCrashBet.betId, crashPayout.betId);
        State.currentCrashBet = {
          ...pendingCrashBet,
          betId: crashPayout.betId,
          pending: false,
        };
      }

      const effectiveCrashBet = State.currentCrashBet || pendingCrashBet;
      const currency = effectiveCrashBet?.currency || crashPayout.currency;
      const resolvedAmount = effectiveCrashBet?.amount ?? State.currentGame.amount ?? "0";
      const multiplier = Number(crashPayout.multiplier ?? 0);

      if (multiplier > 0) {
        this.resolveCrashPayout({
          betId: crashPayout.betId,
          currency: currency,
          amount: resolvedAmount,
          multiplier: multiplier,
          crashGameId: crashPayout.crashGameId || effectiveCrashBet?.crashGameId || null,
        });
      }
    },

    handleCrashGameUpdate(crashUpdate) {
      State.currentCrashState = {
        status: crashUpdate?.status ?? null,
        currentPoint: crashUpdate?.currentPoint ?? null,
        crashPoint: crashUpdate?.crashPoint ?? null,
        crashGameId: crashUpdate?.crashGameId ?? null,
        startedAt: crashUpdate?.startedAt ?? null,
        nextRoundIn: crashUpdate?.nextRoundIn ?? null,
      };

      const pendingCrashBet = State.currentCrashBet;
      if (!pendingCrashBet) return;
      if (State.resolvedCrashBetIds.includes(pendingCrashBet.betId)) {
        State.currentCrashBet = null;
        return;
      }

      const liveGameMatches = !pendingCrashBet.crashGameId ||
        !crashUpdate?.crashGameId ||
        pendingCrashBet.crashGameId === crashUpdate.crashGameId;

      const autoCashoutAt = Number(pendingCrashBet.betAt ?? 0);
      const currentPoint = Number(crashUpdate?.currentPoint ?? 0);
      if (liveGameMatches &&
          crashUpdate?.status === "IN_PROGRESS" &&
          Number.isFinite(autoCashoutAt) &&
          autoCashoutAt > 1 &&
          Number.isFinite(currentPoint) &&
          currentPoint >= autoCashoutAt) {
        this.resolveCrashPayout({
          betId: pendingCrashBet.betId,
          currency: pendingCrashBet.currency,
          amount: pendingCrashBet.amount,
          multiplier: autoCashoutAt,
          crashGameId: pendingCrashBet.crashGameId || crashUpdate?.crashGameId || null,
        });
        return;
      }

      if (crashUpdate?.status !== "CRASHED") return;
      if (pendingCrashBet.crashGameId && crashUpdate?.crashGameId && pendingCrashBet.crashGameId !== crashUpdate.crashGameId) {
        return;
      }

      const gameInfo = BetHistory.getCurrentGameInfo();
      if (gameInfo) {
        BetHistory.addBet({
          id: pendingCrashBet.betId,
          currency: pendingCrashBet.currency,
          amount: String(pendingCrashBet.amount ?? State.currentGame.amount ?? "0"),
          payout: "0",
          multiplier: 0,
          game: {
            id: gameInfo.id,
            name: gameInfo.name,
            gameAndGameCategories: gameInfo.categories,
            slug: gameInfo.slug,
            __typename: "Game"
          }
        });
      }

      State.resolvedCrashBetIds.push(pendingCrashBet.betId);
      if (State.resolvedCrashBetIds.length > 20) {
        State.resolvedCrashBetIds = State.resolvedCrashBetIds.slice(-20);
      }

      State.currentCrashBet = null;
    },

    handleGetNotificationsResponse(response, text) {
      try {
        const serverData = JSON.parse(text);
        const requestBody = State.currentGame.getNotificationsRequest || {};
        const variables = requestBody.variables || {};

        let first = variables.first || 25;
        let cursor = variables.cursor || null;

        const fakeNotifications = NotificationHistory.getNotifications(first, cursor);

        const modifiedData = {
          data: {
            myNotifications: fakeNotifications
          }
        };

        return new Response(JSON.stringify(modifiedData), {
          status: response.status,
          statusText: response.statusText,
          headers: response.headers,
        });
      } catch (e) {
        return response;
      }
    },

    handleUnseenNotificationsCount(response, text) {
      try {
        const data = JSON.parse(text);

        if (data?.data && 'unseenNotificationsCount' in data.data) {
          const unseenCount = State.notificationHistory.filter(n => !n.seenAt && !n.readAt).length;

          data.data.unseenNotificationsCount = unseenCount;

          return new Response(JSON.stringify(data), {
            status: response.status,
            statusText: response.statusText,
            headers: response.headers,
          });
        }
      } catch (e) {
      }

      return response;
    },

    handleGetDepositsResponse(response, text) {
      try {
        const serverData = JSON.parse(text);
        const requestBody = State.currentGame.getDepositsRequest || {};
        const variables = requestBody.variables || {};

        const first = variables.first || 10;
        const cursor = variables.cursor || null;
        const currencyIn = variables.currencyIn || null;

        const fakeDeposits = DepositHistory.getDeposits(first, cursor, currencyIn);

        const modifiedData = {
          data: {
            deposits: fakeDeposits
          }
        };

        return new Response(JSON.stringify(modifiedData), {
          status: response.status,
          statusText: response.statusText,
          headers: response.headers,
        });
      } catch (e) {
        return response;
      }
    },

    handleGetWithdrawalsResponse(response, text) {
      try {
        const requestBody = State.currentGame.getWithdrawalsRequest || {};
        const variables = requestBody.variables || {};
        const currencyIn = variables.currencyIn || null;
        const currencyFilter = Array.isArray(currencyIn)
          ? currencyIn
          : (currencyIn ? [currencyIn] : null);
        const fakeWithdrawals = WithdrawHistory.getWithdrawals(
          variables.first || 20,
          variables.after || variables.cursor || null,
          currencyFilter
        );

        State.currentGame.getWithdrawalsRequest = null;

        return new Response(JSON.stringify({
          data: {
            GetWithdrawals: fakeWithdrawals,
            withdrawals: fakeWithdrawals,
            getWithdrawals: fakeWithdrawals
          }
        }), {
          status: response.status,
          statusText: response.statusText,
          headers: response.headers,
        });
      } catch (e) {
        return response;
      }
    },

    handleGetTipsResponse(response, text) {
      try {
        const requestBody = State.currentGame.getTipsRequest || {};
        const variables = requestBody.variables || {};
        const currencyIn = variables.currencyIn || null;
        const currencyFilter = Array.isArray(currencyIn)
          ? currencyIn
          : (currencyIn ? [currencyIn] : null);
        const fakeTips = TipHistory.getTips(
          variables.first || 20,
          variables.cursor || null,
          currencyFilter,
          variables.searchUser || null
        );

        State.currentGame.getTipsRequest = null;

        return new Response(JSON.stringify({
          data: {
            getTips: fakeTips,
          }
        }), {
          status: response.status,
          statusText: response.statusText,
          headers: response.headers,
        });
      } catch (e) {
        return response;
      }
    },

    handleGetWithdrawableAmountResponse(response, text) {
      try {
        const responseData = JSON.parse(text);
        const requestBody = State.currentGame.getWithdrawableAmountRequest || {};
        const currency = String(
          requestBody?.variables?.currency
          || responseData?.data?.withdrawableAmount?.currency
          || "SOL"
        ).trim().toUpperCase();
        const withdrawableAmount = Balance.getWithdrawableAmount(currency);

        State.currentGame.getWithdrawableAmountRequest = null;

        return new Response(JSON.stringify({
          data: {
            withdrawableAmount: {
              withdrawableAmount,
              __typename: "WithdrawableAmount",
            }
          }
        }), {
          status: response.status,
          statusText: response.statusText,
          headers: response.headers,
        });
      } catch (e) {
        return response;
      }
    },

    handlePlaceSportsBetsRequest(req) {
      const data = req?.variables?.data || {};
      const currency = String(data.currency || "USDT").toUpperCase();
      const bets = Array.isArray(data.bets) ? data.bets : [];
      const results = [];

      bets.forEach((betInput, index) => {
        const amount = Number(betInput?.amount || 0);
        if (amount > 0 && currency) {
          const currentBal = Balance.get(currency) || 0;
          const nextBal = Math.max(0, currentBal - amount);
          Balance.set(currency, nextBal);
          WebSocketInjector.injectBalanceUpdate(currency, nextBal);

          const usdAmount = CurrencyUsdRates.getUsdAmount(currency, amount, null);
          if (Number.isFinite(usdAmount) && usdAmount > 0) {
            Profile.addWager(usdAmount, {
              currency,
              amount,
              operationName: "placeSportsBets",
              gameKey: "sports",
            });
          }
        }

        const bet = SportsBetHistory.addFromPlaceInput(betInput, currency);
        results.push({
          key: String(index),
          betPayload: JSON.stringify(bet),
          error: null,
          __typename: "PlaceSportsBetResult",
        });
      });

      console.log("[LARP] Sports bet placed:", { currency, count: results.length, targetWsExists: !!window.targetWs });

      // Notify subscribers of new bets placed.
      // The drawer usually subscribes to the sports-bets query/count stream, not just a generic update event.
      results.forEach((result) => {
        try {
          const betPayload = result.betPayload ? JSON.parse(result.betPayload) : null;
          if (!betPayload || !betPayload.id) {
            return;
          }

          const normalizedSportsBet = {
            ...betPayload,
            status: betPayload.status || "PENDING",
            legs: Array.isArray(betPayload.legs) ? betPayload.legs : [],
            settlement: betPayload.settlement || null,
          };

          WebSocketInjector.injectSportsBetUpdated(normalizedSportsBet);

          if (window.targetWs?.injectResponse) {
            const freshSportsBets = SportsBetHistory.getSportsBets(10, null, [currency], ["PENDING"]);
            window.targetWs.injectResponse("GetSportsBets", {
              sportsBets: freshSportsBets,
            });
            window.targetWs.injectResponse("SportsBetsCount", {
              sportsBetsCount: SportsBetHistory.countBets(["PENDING"], [currency]),
            });
            window.targetWs.injectResponse("SportsBetsAdded", {
              sportsBet: normalizedSportsBet,
            });
            window.targetWs.injectResponse("sportsBetsAdded", {
              sportsBet: normalizedSportsBet,
            });
            console.log("[LARP] Injected sports-bet refresh payload for:", normalizedSportsBet.id);
          }

          if (typeof window.syncSportsBetQueryResponses === 'function') {
            window.syncSportsBetQueryResponses(currency, 'PENDING');
          }

          try {
            document.dispatchEvent(new CustomEvent("larp:sports:refresh", {
              detail: { bet: normalizedSportsBet, currency }
            }));
          } catch (e) {
          }
        } catch (e) {
          console.log("[LARP] Error notifying My Bets of new sports bet:", e?.message || e);
        }
      });

      State._suppressSportsNetworkErrUntil = Date.now() + 12000;
      setTimeout(() => {
        SportsPlaceUI.onAccepted();
        SportsToastGuard.scrub();

        if (typeof window.syncSportsBetQueryResponses === 'function') {
          window.syncSportsBetQueryResponses(currency, 'PENDING');
        }

        if (typeof window.refreshMyBetsDrawer === 'function') {
          window.refreshMyBetsDrawer();
        }

        if (typeof window.injectBetsIntoMyBetsDrawer === 'function') {
          window.injectBetsIntoMyBetsDrawer();
        }
      }, 60);

      return new Response(JSON.stringify({
        data: {
          placeSportsBets: results,
        }
      }), {
        status: 200,
        statusText: "OK",
        headers: { "content-type": "application/json" },
      });
    },

    handleSportBetCashOutRequest(req) {
      const input = req?.variables?.input || req?.variables?.data || req?.variables || {};
      const betId = input.sportsBetId || input.id || input.betId;
      const cashoutOddsDecimal = input.cashoutOddsDecimal || null;
      const updatedBet = SportsBetHistory.cashoutBet(betId, cashoutOddsDecimal);

      if (!updatedBet) {
        return new Response(JSON.stringify({
          data: {
            sportBetCashOut: null,
            sportBetCashOutV2: null,
          },
          errors: [{
            message: "Sports bet not found or not cashout eligible",
          }],
        }), {
          status: 200,
          statusText: "OK",
          headers: { "content-type": "application/json" },
        });
      }

      console.log("[LARP] Sports bet cashed out:", { betId, payout: updatedBet.settlement?.payout });

      return new Response(JSON.stringify({
        data: {
          sportBetCashOut: updatedBet,
          sportBetCashOutV2: updatedBet,
        }
      }), {
        status: 200,
        statusText: "OK",
        headers: { "content-type": "application/json" },
      });
    },

    handleGetSportsBetsResponse(response, text) {
      try {
        const requestBody = State.currentGame.getSportsBetsRequest || {};
        const variables = requestBody.variables || {};
        const currencyIn = variables.currencyIn || null;
        const currencyFilter = Array.isArray(currencyIn)
          ? currencyIn
          : (currencyIn ? [currencyIn] : null);
        const fakeSportsBets = SportsBetHistory.getSportsBets(
          variables.first || 10,
          variables.after || variables.cursor || null,
          currencyFilter,
          variables.statuses || null
        );

        State.currentGame.getSportsBetsRequest = null;

        return new Response(JSON.stringify({
          data: {
            sportsBets: fakeSportsBets,
          }
        }), {
          status: response.status,
          statusText: response.statusText,
          headers: response.headers,
        });
      } catch (e) {
        return response;
      }
    },

    handleGetSportsBetResponse(response, text) {
      try {
        const requestBody = State.currentGame.getSportsBetRequest || {};
        const betId = requestBody?.variables?.id;
        const bet = SportsBetHistory.getBetForResponse(betId);

        State.currentGame.getSportsBetRequest = null;

        if (!bet) {
          return response;
        }

        return new Response(JSON.stringify({
          data: {
            sportsBet: bet,
          }
        }), {
          status: response.status,
          statusText: response.statusText,
          headers: response.headers,
        });
      } catch (e) {
        return response;
      }
    },

    handleGameResult(response, text) {
      const data = JSON.parse(text);

      const actionKey = Object.keys(data.data || {}).find(k =>
        k.includes('Start') || k.includes('Play') || k.includes('Bet') || k.includes('Next') || k.includes('Cashout') || k.includes('Auto')
      );

      if (!actionKey) return response;

      const bet = data.data[actionKey];
      if (!bet) return response;

      const originalActions = Array.isArray(bet.shuffleOriginalActions) ? bet.shuffleOriginalActions : [];
      const latestAction = originalActions.length > 0 ? originalActions[originalActions.length - 1] : null;
      const latestTowerData = latestAction?.action?.tower;
      const latestMinesData = latestAction?.action?.mines;
      const latestChickenData = latestAction?.action?.chicken;
      const latestHiloData = latestAction?.action?.hilo;
      const latestCrashData = latestAction?.action?.crash;
      const currency = State.currentGame.currency;
      const wager = Number(State.currentGame.amount ?? 0);
      const balanceBeforeBet = State.currentGame.balanceBeforeBet ?? Balance.get(currency);

      bet.currency = currency;
      bet.amount = String(State.currentGame.amount);

      const updateBalance = (newBalance) => {
        if (currency && newBalance != null) {
          bet.afterBalance = String(newBalance);
          const balanceUpdateOptions = (() => {
            if (["baccaratPlay", "baccaratBet", "baccaratStart"].includes(actionKey)) {
              return { delayMs: 600 };
            }

            if (actionKey === "plinkoPlay") {
              return { delayMs: 600 };
            }

            if (actionKey === "dicePlay") {
              return { delayMs: 500 };
            }

            if (actionKey === "coinflipClassicPlay") {
              return { delayMs: 400 };
            }

            if (actionKey === "coinflipClassicAutobet") {
              return { delayMs: 500 };
            }

            if ([
              "coinflipClassicProgressiveStart",
              "coinflipClassicProgressiveNext",
              "coinflipClassicProgressiveCashout",
            ].includes(actionKey)) {
              return { delayMs: 400 };
            }

            if (["limboPlay", "kenoPlay", "wheelPlay"].includes(actionKey)) {
              return { delayMs: 350 };
            }

            if (actionKey === "slidePlay") {
              return { delayMs: 9000 };
            }

            if (actionKey === "roulettePlay") {
              return { delayMs: 1400 };
            }

            if (["blitzPlay", "blitzBet", "blitzStart"].includes(actionKey)) {
              return { delayMs: 400 };
            }

            if (["blackjackStart", "blackjackNext", "blackjackActiveBet"].includes(actionKey)) {
              return { delayMs: 6000 };
            }

            return undefined;
          })();
          Balance.set(currency, newBalance, balanceUpdateOptions);
        }
      };

      let newBalance = null;
      let outcome = null;

      const bjOps = ["blackjackStart", "blackjackNext", "blackjackActiveBet"];
      const cashoutOps = ["minesCashout", "towerCashout", "chickenCashout", "hiloCashout"];
      const startOps = ["minesStart", "towerStart", "chickenStart", "hiloStart"];
      if (bjOps.includes(actionKey)) {
        if (!wager || wager <= 0) {
          return new Response(JSON.stringify(data), {
            status: response.status,
            statusText: response.statusText,
            headers: response.headers,
          });
        }

        bet.amount = String(State.currentGame.amount);
        bet.originalAmount = String(State.currentGame.amount);

        if (originalActions.length > 0) {
          originalActions.forEach(item => {
            if (item?.action?.blackjack) {
              item.action.blackjack.originalMainBetAmount = String(State.currentGame.amount);
            }
          });
        }

        const blackjackData = latestAction?.action?.blackjack || {};
        const blackjackRound = BlackjackLogic.ensureRound(wager, balanceBeforeBet);
        if (actionKey === "blackjackStart") {
          const startAmounts = BlackjackLogic.getSideBetAmounts(blackjackRound, blackjackData);
          blackjackRound.perfectPairAmount = startAmounts.perfectPairAmount;
          blackjackRound.twentyOnePlusThreeAmount = startAmounts.twentyOnePlusThreeAmount;
        }
        const chargeActionType =
          blackjackRound.pendingActionType ||
          (actionKey === "blackjackNext"
            ? BlackjackLogic.inferLatestActionType(blackjackData, blackjackRound)
            : null);
        const actionType = blackjackRound.mode || chargeActionType || null;
        const chargeSignature = `${bet.id || "blackjack"}|${actionKey}|${originalActions.length}|${chargeActionType || "base"}`;
        const chargedExtraStake =
          actionKey !== "blackjackStart" &&
          BlackjackLogic.chargeExtraStake(blackjackRound, chargeActionType, chargeSignature);
        const extraStakeCharge = chargedExtraStake ? wager : 0;
        const currentBal = Balance.get(currency);
        const handOutcomes = BlackjackLogic.extractHandOutcomes(blackjackData);
        const committedStake = BlackjackLogic.getCommittedStake(wager, blackjackRound);
        BlackjackLogic.resolveSideBets(bet, blackjackData, blackjackRound);
        BlackjackLogic.syncBlackjackSideBetsToResponse(bet, blackjackRound);
        const sideBetAmounts = BlackjackLogic.getSideBetAmounts(blackjackRound, blackjackData);
        const settledResult = BlackjackLogic.getResolvedPayout({
          wager,
          bet,
          outcomes: handOutcomes,
          round: blackjackRound,
          actionType,
        });
        const sideBetPayout = settledResult ? (Number(blackjackRound.sideBetPayout) || 0) : 0;

        outcome = settledResult?.outcome || handOutcomes.find(value => BlackjackLogic.isSettledOutcome(value)) || null;

        if (settledResult) {
          blackjackRound.settled = true;
          blackjackRound.pendingActionType = null;
          bet.payout = String(settledResult.payout);
          bet.multiplier = settledResult.multiplier;

          if (actionKey === "blackjackStart") {
            const initialStake = BlackjackLogic.getInitialStake(wager, blackjackRound);
            newBalance = Math.max(0, balanceBeforeBet - initialStake + sideBetPayout + settledResult.payout);
          } else {
            newBalance = Math.max(0, currentBal - extraStakeCharge + settledResult.payout + sideBetPayout);
          }

          if (sideBetPayout > 0) {
            const totalPayout = settledResult.payout + sideBetPayout;
            bet.payout = String(totalPayout);
            bet.multiplier = wager > 0 ? totalPayout / wager : 0;
          }
        } else {
          bet.payout = bet.payout ?? "0";

          if (actionKey === "blackjackStart") {
            const initialStake = BlackjackLogic.getInitialStake(wager, blackjackRound);
            newBalance = Math.max(0, balanceBeforeBet - initialStake);
          } else if (chargedExtraStake) {
            newBalance = Math.max(0, currentBal - wager);
          } else {
            // On hit/stand (no extra charge), keep balance at current fake balance
            newBalance = currentBal;
          }
        }

        BlackjackLogic.updateActionSnapshot(blackjackRound, blackjackData);
      } else if (actionKey === "towerNext") {
        if (latestTowerData?.towerResult && latestTowerData.towerResult.length > 0) {
          const winMultiplier = Number(latestTowerData.winMultiplier) || 0;
          const currentBal = Balance.get(currency);

          if (winMultiplier > 0) {
            const payout = wager * winMultiplier;
            bet.payout = String(payout);
            bet.multiplier = winMultiplier;
            newBalance = currentBal + payout;

          } else {
            bet.payout = "0";
            bet.multiplier = 0;
            newBalance = currentBal;

          }
        }
      } else if (actionKey === "minesNext") {
        if (latestMinesData?.minesResult && latestMinesData.minesResult.length > 0) {
          bet.payout = "0";
          bet.multiplier = 0;
          newBalance = Balance.get(currency);
        }
      } else if (actionKey === "crashPlay") {
        newBalance = GameLogic.handlers.start(bet, wager, currency);
        const crashGameInfo = BetHistory.getCurrentGameInfo();
        const pendingCrashBetId = State.currentCrashBet?.pending ? State.currentCrashBet.betId : null;
        State.currentCrashBet = {
          betId: bet.id,
          crashGameId: bet.crashBet?.crashGameId || null,
          amount: bet.amount,
          currency: currency,
          betAt: State.currentGame.crashBetAt ?? latestCrashData?.betAt ?? null,
          pending: false,
        };
        if (pendingCrashBetId && pendingCrashBetId !== bet.id) {
          BetHistory.rekeyBet(pendingCrashBetId, bet.id);
        }
        if (crashGameInfo) {
          BetHistory.addBet({
            id: bet.id,
            currency: currency,
            amount: bet.amount,
            payout: "0",
            multiplier: 0,
            game: {
              id: crashGameInfo.id,
              name: crashGameInfo.name,
              gameAndGameCategories: crashGameInfo.categories,
              slug: crashGameInfo.slug,
              __typename: "Game"
            }
          });
        }
      } else if (actionKey === "hiloNext") {
        if (latestHiloData?.actionType === "WRONG_GUESS") {
          bet.payout = "0";
          bet.multiplier = 0;
          newBalance = Balance.get(currency);
        }
      } else if (actionKey === "limboPlay") {
        newBalance = GameLogic.handlers.limbo(bet, wager, currency);
      } else if (actionKey === "slidePlay") {
        newBalance = GameLogic.handlers.slide(bet, wager, currency);
      } else if (actionKey === "dicePlay") {
        newBalance = GameLogic.handlers.dice(bet, wager, currency);
      } else if (actionKey === "coinflipClassicPlay") {
        newBalance = GameLogic.handlers.coinflip(bet, wager, currency);
      } else if (actionKey === "coinflipClassicAutobet") {
        newBalance = GameLogic.handlers.coinflipAutobet(bet, wager, currency);
      } else if (actionKey === "coinflipClassicProgressiveStart") {
        newBalance = GameLogic.handlers.coinflipProgressiveStart(bet, wager, currency);
      } else if (actionKey === "coinflipClassicProgressiveNext") {
        newBalance = GameLogic.handlers.coinflipProgressiveNext(bet, wager, currency);
      } else if (actionKey === "coinflipClassicProgressiveCashout") {
        newBalance = GameLogic.handlers.coinflipProgressiveCashout(bet, wager, currency);
      } else if (actionKey === "kenoPlay") {
        newBalance = GameLogic.handlers.keno(bet, wager, currency);
      } else if (actionKey === "plinkoPlay") {
        newBalance = GameLogic.handlers.instant(bet, wager, currency);
      } else if (["baccaratPlay", "baccaratBet", "baccaratStart"].includes(actionKey)) {
        // Override afterBalance with our fake balance so frontend doesn't reset to real $0
        if (State._pendingBacBet) {
          bet.afterBalance = String(State._pendingBacBet.balanceAfterBet);
          bet.amount = String(State._pendingBacBet.wager);
        }
        return new Response(JSON.stringify(data), {
          status: response.status,
          statusText: response.statusText,
          headers: response.headers,
        });
      } else if (["blitzPlay", "blitzBet", "blitzStart"].includes(actionKey)) {
        // Deduplicate Start+Play for the same bet id.
        if (bet?.id && State.currentGame.blitzHandledBetId === bet.id) {
          newBalance = Balance.get(currency);
        } else {
          if (bet?.id) State.currentGame.blitzHandledBetId = bet.id;
          State.currentGame.blitzWagerDeducted = false;
          newBalance = GameLogic.handlers.blitz(bet, wager, currency);
        }
      } else if (actionKey === "wheelPlay") {
        newBalance = GameLogic.handlers.wheel(bet, wager, currency, balanceBeforeBet);
      } else if (cashoutOps.includes(actionKey)) {
        newBalance = GameLogic.handlers.cashout(bet, wager, currency);
      } else if (actionKey === "minesAuto") {
        newBalance = GameLogic.handlers.instant(bet, wager, currency);
      } else if (startOps.includes(actionKey)) {
        newBalance = GameLogic.handlers.start(bet, wager, currency);
      }

      updateBalance(newBalance);
      const shouldSaveBet =
        actionKey === "minesAuto" ||
        actionKey === "dicePlay" ||
        actionKey === "coinflipClassicPlay" ||
        actionKey === "coinflipClassicAutobet" ||
        actionKey === "coinflipClassicProgressiveCashout" ||
        (actionKey === "coinflipClassicProgressiveNext"
          && (Number(bet.payout) > 0
            || (String(bet.payout) === "0"
              && Number(bet.multiplier) === 0
              && !State.coinflipProgressiveRound?.active))) ||
        actionKey === "limboPlay" ||
        actionKey === "kenoPlay" ||
        actionKey === "plinkoPlay" ||
        ["baccaratPlay", "baccaratBet", "baccaratStart"].includes(actionKey) ||
        ["blitzPlay", "blitzBet", "blitzStart"].includes(actionKey) ||
        actionKey === "wheelPlay" ||
        actionKey === "minesCashout" ||
        actionKey === "towerCashout" ||
        (bjOps.includes(actionKey) && outcome && outcome !== "PENDING" && outcome !== "NONE") ||
        (actionKey === "towerNext" && latestTowerData?.towerResult?.length > 0) ||
        (actionKey === "minesNext" && latestMinesData?.minesResult?.length > 0) ||
        (actionKey === "chickenCashout" && latestChickenData?.chickenResult?.length > 0) ||
        (actionKey === "hiloCashout" && latestHiloData?.actionType === "CASHOUT") ||
        (actionKey === "hiloNext" && latestHiloData?.actionType === "WRONG_GUESS");

      if (shouldSaveBet) {
        const gameInfo = BetHistory.getCurrentGameInfo();
        if (gameInfo) {
          if (bet.payout === undefined || bet.payout === null) {
            bet.payout = "0";
          }

          const wagerAmount = Number(bet.amount) || wager || 0;
          const payoutAmount = Number(bet.payout) || 0;

          let calculatedMultiplier = 0;
          if (wagerAmount > 0 && payoutAmount > 0) {
            calculatedMultiplier = payoutAmount / wagerAmount;
          }

          const finalMultiplier = (bet.multiplier && bet.multiplier > 0)
            ? bet.multiplier
            : calculatedMultiplier;

          const limboActionForHistory = actionKey === "limboPlay"
            ? (Array.isArray(bet.shuffleOriginalActions)
                ? bet.shuffleOriginalActions.map((item) => item?.action?.limbo).find(Boolean)
                : null)
            : null;
          const resultMultiplierForHistory = limboActionForHistory
            ? Number(
                limboActionForHistory.resultMultiplier
                ?? limboActionForHistory.resultValue
                ?? limboActionForHistory.rollMultiplier
                ?? limboActionForHistory.multiplier
                ?? 0
              )
            : null;

          const kenoActionForHistory = actionKey === "kenoPlay"
            ? (Array.isArray(bet.shuffleOriginalActions)
                ? bet.shuffleOriginalActions.map((item) => item?.action?.keno).find(Boolean)
                : null)
            : null;
          const kenoDrawnForHistory = kenoActionForHistory
            ? (GameLogic.extractKenoNumbers({
                numbers: kenoActionForHistory.drawnNumbers
                  || kenoActionForHistory.resultNumbers
                  || kenoActionForHistory.kenoResult
                  || kenoActionForHistory.drawnTiles
                  || kenoActionForHistory.results,
              }).length
                ? GameLogic.extractKenoNumbers({
                    numbers: kenoActionForHistory.drawnNumbers
                      || kenoActionForHistory.resultNumbers
                      || kenoActionForHistory.kenoResult
                      || kenoActionForHistory.drawnTiles
                      || kenoActionForHistory.results,
                  })
                : (State.kenoForceLast?.isWin ? State.kenoForceLast.drawnNumbers : undefined))
            : undefined;
          const kenoSelectedForHistory = kenoActionForHistory
            ? (GameLogic.extractKenoNumbers(kenoActionForHistory).length
                ? GameLogic.extractKenoNumbers(kenoActionForHistory)
                : State.kenoForceLast?.selectedNumbers)
            : undefined;

          BetHistory.addBet({
            id: bet.id,
            currency: currency,
            amount: bet.amount,
            payout: payoutAmount > 0 ? bet.payout : 0,
            multiplier: finalMultiplier,
            resultMultiplier: Number.isFinite(resultMultiplierForHistory) && resultMultiplierForHistory > 0
              ? resultMultiplierForHistory
              : undefined,
            kenoDrawnNumbers: Array.isArray(kenoDrawnForHistory) ? kenoDrawnForHistory : undefined,
            kenoSelectedNumbers: Array.isArray(kenoSelectedForHistory) ? kenoSelectedForHistory : undefined,
            hitCount: State.kenoForceLast?.isWin ? State.kenoForceLast.hitCount : undefined,
            diceResultValue: actionKey === "dicePlay"
              ? (State.diceForceLast?.resultValue
                  ?? Number(bet.shuffleOriginalActions?.[0]?.action?.dice?.resultValue))
              : undefined,
            diceUserValue: actionKey === "dicePlay"
              ? (State.diceForceLast?.userValue
                  ?? Number(bet.shuffleOriginalActions?.[0]?.action?.dice?.userValue))
              : undefined,
            diceDirection: actionKey === "dicePlay"
              ? (State.diceForceLast?.direction
                  ?? bet.shuffleOriginalActions?.[0]?.action?.dice?.userDiceDirection)
              : undefined,
            blitzCards: ["blitzPlay", "blitzBet", "blitzStart"].includes(actionKey)
              ? (State.blitzForceLast?.isWin ? State.blitzForceLast.cards : undefined)
              : undefined,
            blitzUniqueCards: ["blitzPlay", "blitzBet", "blitzStart"].includes(actionKey)
              ? (State.blitzForceLast?.isWin ? State.blitzForceLast.uniqueCards : undefined)
              : undefined,
            game: {
              id: gameInfo.id,
              name: gameInfo.name,
              gameAndGameCategories: gameInfo.categories,
              slug: gameInfo.slug,
              __typename: 'Game'
            }
          });
        }
      }

      return new Response(JSON.stringify(data), {
        status: response.status,
        statusText: response.statusText,
        headers: response.headers,
      });
    }
  }

  __subscriptionMessageHandler = (event) => {
    Handlers.handleWebSocketMessage(event);
  };
  __subscriptionMessageTransform = (event) => {
    return Handlers.transformWebSocketMessage(event);
  };

  const SlotSupport = {
    bypassClicks: new WeakSet(),
    sessionActive: false,
    exitInProgress: false,
    activeCurrency: "",
    lastDemoUsd: null,
    walletPlayingText: "Playing",
    walletHeaderTimer: null,
    trackedWalletNodes: new WeakSet(),

    init() {
      if (!__isShuffleHost) {
        return;
      }

      document.addEventListener("click", (event) => this.handlePlayModeClick(event), true);
      document.addEventListener("click", (event) => this.handleExitClick(event), true);
      window.addEventListener("popstate", () => this.exitSlot());
      window.addEventListener("message", (event) => this.handleBridgeMessage(event));

      document.addEventListener("load", (event) => {
        if (event.target instanceof HTMLIFrameElement) {
          this.broadcastDemoBalance();
        }
      }, true);

      if (typeof MutationObserver !== "undefined" && document.body) {
        const observer = new MutationObserver(() => {
          this.watchSlotPresence();
          this.syncPlayModeFooterHighlight();
        });
        observer.observe(document.body, {
          childList: true,
          subtree: true,
          attributes: true,
          attributeFilter: ["src", "class", "disabled"],
        });
      }

      this.watchSlotPresence();
      this.syncPlayModeFooterHighlight();
      setInterval(() => {
        if (this.sessionActive) {
          this.broadcastDemoBalance();
          this.setWalletHeaderPlaying();
          this.syncPlayModeFooterHighlight();
        }
      }, 1000);
    },

    getWalletBalanceNodes() {
      const selectors = [
        '#balance-button [data-testid="balance"]',
        '#balance-button .formatted-amount-value',
        '.BalanceSelect_balanceBtn__a2IXa [data-testid="balance"]',
        '.BalanceSelect_balanceBtn__a2IXa .formatted-amount-value',
        'span.formatted-amount-value[data-testid="balance"]',
      ];

      const nodes = [];
      const seen = new Set();
      selectors.forEach((selector) => {
        document.querySelectorAll(selector).forEach((node) => {
          if (node instanceof Element && !seen.has(node)) {
            seen.add(node);
            nodes.push(node);
          }
        });
      });

      return nodes;
    },

    getWalletBalanceDisplayText() {
      const currency = this.activeCurrency || this.getActiveCurrency();
      const usdValue = this.getWalletUsdValue(currency);
      return formatUsdDisplay(usdValue);
    },

    setWalletHeaderPlaying() {
      this.getWalletBalanceNodes().forEach((node) => {
        setNodeTextValue(node, this.walletPlayingText);

        if (!this.trackedWalletNodes.has(node) && typeof MutationObserver !== "undefined") {
          this.trackedWalletNodes.add(node);
          const observer = new MutationObserver(() => {
            if (this.sessionActive && node.textContent !== this.walletPlayingText) {
              setNodeTextValue(node, this.walletPlayingText);
            }
          });
          observer.observe(node, {
            childList: true,
            characterData: true,
            subtree: true,
          });
        }
      });
    },

    restoreWalletHeader() {
      const displayText = this.getWalletBalanceDisplayText();
      if (!displayText) {
        return;
      }

      this.getWalletBalanceNodes().forEach((node) => {
        setNodeTextValue(node, displayText);
      });
    },

    normalizeLabel(value) {
      return String(value || "").replace(/\s+/g, " ").trim().toLowerCase();
    },

    getButtonLabel(button) {
      const ariaLabel = this.normalizeLabel(button?.getAttribute?.("aria-label"));
      const textLabel = this.normalizeLabel(button?.textContent);
      return ariaLabel || textLabel;
    },

    isRealPlayLabel(label) {
      const normalized = this.normalizeLabel(label);
      return normalized === "real play"
        || normalized === "real"
        || (normalized.includes("real play") && !normalized.includes("fun"));
    },

    isFunPlayLabel(label) {
      const normalized = this.normalizeLabel(label);
      return normalized === "fun play"
        || normalized === "fun"
        || normalized === "demo play"
        || normalized === "demo"
        || normalized.includes("fun play")
        || normalized.includes("demo play");
    },

    isPlayModeLabel(label) {
      return this.isRealPlayLabel(label) || this.isFunPlayLabel(label);
    },

    stampPlayModeRoles(realButton, funButton) {
      if (realButton instanceof Element) {
        realButton.dataset.larpPlayRole = "real";
      }
      if (funButton instanceof Element) {
        funButton.dataset.larpPlayRole = "fun";
      }
    },

    getPlayModeRole(button) {
      if (!(button instanceof Element)) {
        return null;
      }

      const stampedRole = String(button.dataset.larpPlayRole || "").toLowerCase();
      if (stampedRole === "real" || stampedRole === "fun") {
        return stampedRole;
      }

      const label = this.getButtonLabel(button);
      if (this.isRealPlayLabel(label)) {
        return "real";
      }
      if (this.isFunPlayLabel(label)) {
        return "fun";
      }

      return null;
    },

    getPlayModeButtonContent(button) {
      if (!(button instanceof Element)) {
        return null;
      }

      return button.querySelector('[class*="buttonContent"]') || button;
    },

    capturePlayModeHighlightBaseline(realButton, funButton) {
      if (!(realButton instanceof Element) || !(funButton instanceof Element)) {
        return;
      }

      if (realButton.dataset.larpHighlightBaseline === "1") {
        return;
      }

      this.stampPlayModeRoles(realButton, funButton);

      const realContent = this.getPlayModeButtonContent(realButton);
      const funContent = this.getPlayModeButtonContent(funButton);

      realButton.dataset.larpHighlightBaseline = "1";
      realButton.dataset.larpInactiveClass = realButton.className;
      realButton.dataset.larpInactiveDisabled = realButton.disabled ? "1" : "0";
      funButton.dataset.larpActiveClass = funButton.className;
      funButton.dataset.larpActiveDisabled = funButton.disabled ? "1" : "0";

      if (realContent instanceof Element) {
        realButton.dataset.larpInactiveContentClass = realContent.className;
      }
      if (funContent instanceof Element) {
        funButton.dataset.larpActiveContentClass = funContent.className;
      }
    },

    applyPlayModeButtonAppearance(button, className, disabled, contentClassName) {
      if (!(button instanceof Element) || typeof className !== "string") {
        return;
      }

      if (button.className !== className) {
        button.className = className;
      }

      button.disabled = Boolean(disabled);

      if (typeof contentClassName === "string") {
        const content = this.getPlayModeButtonContent(button);
        if (content instanceof Element && content.className !== contentClassName) {
          content.className = contentClassName;
        }
      }
    },

    applyFooterShowsRealActive(realButton, funButton) {
      if (!(realButton instanceof Element) || !(funButton instanceof Element)) {
        return;
      }

      this.capturePlayModeHighlightBaseline(realButton, funButton);

      const activeClass = funButton.dataset.larpActiveClass || funButton.className;
      const inactiveClass = realButton.dataset.larpInactiveClass || realButton.className;
      const activeDisabled = funButton.dataset.larpActiveDisabled === "1";
      const inactiveDisabled = realButton.dataset.larpInactiveDisabled === "1";
      const activeContentClass = funButton.dataset.larpActiveContentClass || "";
      const inactiveContentClass = realButton.dataset.larpInactiveContentClass || "";

      this.applyPlayModeButtonAppearance(realButton, activeClass, activeDisabled, activeContentClass);
      this.applyPlayModeButtonAppearance(funButton, inactiveClass, inactiveDisabled, inactiveContentClass);
      realButton.dataset.larpHighlightApplied = "1";
    },

    restorePlayModeFooterHighlight(realButton, funButton) {
      if (!(realButton instanceof Element) || !(funButton instanceof Element)) {
        return;
      }

      if (realButton.dataset.larpHighlightBaseline !== "1") {
        return;
      }

      const activeClass = funButton.dataset.larpActiveClass || funButton.className;
      const inactiveClass = realButton.dataset.larpInactiveClass || realButton.className;
      const activeDisabled = funButton.dataset.larpActiveDisabled === "1";
      const inactiveDisabled = realButton.dataset.larpInactiveDisabled === "1";
      const activeContentClass = funButton.dataset.larpActiveContentClass || "";
      const inactiveContentClass = realButton.dataset.larpInactiveContentClass || "";

      this.applyPlayModeButtonAppearance(realButton, inactiveClass, inactiveDisabled, inactiveContentClass);
      this.applyPlayModeButtonAppearance(funButton, activeClass, activeDisabled, activeContentClass);

      delete realButton.dataset.larpHighlightApplied;
      delete realButton.dataset.larpHighlightBaseline;
      delete realButton.dataset.larpInactiveClass;
      delete realButton.dataset.larpInactiveDisabled;
      delete realButton.dataset.larpInactiveContentClass;
      delete funButton.dataset.larpActiveClass;
      delete funButton.dataset.larpActiveDisabled;
      delete funButton.dataset.larpActiveContentClass;
    },

    findPlayModeButtonPair(container) {
      if (!(container instanceof Element)) {
        return null;
      }

      const buttons = [...container.querySelectorAll("button")].filter((button) => {
        return this.isPlayModeLabel(this.getButtonLabel(button));
      });

      if (buttons.length < 2) {
        return null;
      }

      let realButton = null;
      let funButton = null;

      buttons.forEach((button) => {
        const role = this.getPlayModeRole(button);
        if (role === "real") {
          realButton = button;
        } else if (role === "fun") {
          funButton = button;
        }
      });

      if (!(realButton instanceof Element) || !(funButton instanceof Element)) {
        buttons.forEach((button) => {
          const label = this.getButtonLabel(button);
          if (!realButton && this.isRealPlayLabel(label)) {
            realButton = button;
          } else if (!funButton && this.isFunPlayLabel(label)) {
            funButton = button;
          }
        });
      }

      if (!(realButton instanceof Element) || !(funButton instanceof Element) || realButton === funButton) {
        return null;
      }

      return { realButton, funButton };
    },

    getPlayModeFooterContainers() {
      const selectors = [
        '[class*="ProviderGamesFooter_gameSelect"]',
        '#game-footer [class*="ProviderGamesFooter_gameSelect"]',
      ];
      const containers = [];
      const seen = new Set();

      selectors.forEach((selector) => {
        document.querySelectorAll(selector).forEach((container) => {
          if (!(container instanceof Element) || seen.has(container)) {
            return;
          }
          seen.add(container);
          containers.push(container);
        });
      });

      return containers;
    },

    syncPlayModeFooterHighlight() {
      this.getPlayModeFooterContainers().forEach((container) => {
        const pair = this.findPlayModeButtonPair(container);
        if (!pair) {
          return;
        }

        if (this.sessionActive) {
          this.applyFooterShowsRealActive(pair.realButton, pair.funButton);
          return;
        }

        if (pair.realButton.dataset.larpHighlightApplied === "1") {
          this.restorePlayModeFooterHighlight(pair.realButton, pair.funButton);
        }
      });
    },

    isInProviderGameContext(element) {
      if (!(element instanceof Element)) {
        return false;
      }

      return Boolean(
        element.closest('[class*="ProviderGame"]')
        || element.closest('[class*="ProviderGamesFooter"]')
        || element.closest("#game-footer")
        || element.closest('[class*="SoftswissLoader"]')
        || element.closest('[class*="ProviderGameOverlay"]')
      );
    },

    findCounterpartButton(sourceButton, wantFunPlay) {
      const roots = [...new Set([
        sourceButton.getRootNode?.(),
        sourceButton.closest('[class*="ProviderGame"]'),
        sourceButton.closest('[class*="ProviderGameOverlay"]'),
        sourceButton.closest("#game-footer"),
        document,
      ].filter(Boolean))];

      for (const root of roots) {
        const candidates = root.querySelectorAll?.('button, [role="button"]') || [];
        for (const candidate of candidates) {
          if (candidate === sourceButton || !(candidate instanceof Element)) {
            continue;
          }

          const label = this.getButtonLabel(candidate);
          if (wantFunPlay ? this.isFunPlayLabel(label) : this.isRealPlayLabel(label)) {
            return candidate;
          }
        }
      }

      return null;
    },

    triggerClick(button) {
      if (!(button instanceof Element)) {
        return;
      }

      this.bypassClicks.add(button);
      try {
        button.click();
      } finally {
        setTimeout(() => this.bypassClicks.delete(button), 0);
      }
    },

    handlePlayModeClick(event) {
      const target = event?.target;
      if (!(target instanceof Element) || !event.isTrusted) {
        return;
      }

      const button = target.closest('button, [role="button"]');
      if (!(button instanceof Element) || this.bypassClicks.has(button)) {
        return;
      }

      if (!this.isInProviderGameContext(button)) {
        return;
      }

      const label = this.getButtonLabel(button);
      if (!this.isRealPlayLabel(label)) {
        return;
      }

      // Always arm LARP session. Live tables often have no Fun Play button â€” GameCreateSession
      // is still forced into demoMode by the GraphQL intercept.
      this.enterSlot();
      [0, 150, 400, 900, 2000, 4000].forEach((delayMs) => {
        setTimeout(() => this.broadcastDemoBalance(), delayMs);
      });

      const counterpart = this.findCounterpartButton(button, true);
      if (!(counterpart instanceof Element)) {
        return;
      }

      event.preventDefault();
      event.stopImmediatePropagation?.();
      event.stopPropagation();
      this.triggerClick(counterpart);
    },

    handleExitClick(event) {
      const target = event?.target;
      if (!(target instanceof Element)) {
        return;
      }

      const leaveTarget = target.closest(
        'a[href="/"], a[href="/casino"], a[href^="/casino/"], [class*="ProviderGame"] [class*="close" i], [class*="ProviderGameOverlay"] [class*="close" i], [aria-label*="close" i], [aria-label*="back" i], [aria-label*="exit" i]'
      );
      if (!(leaveTarget instanceof Element)) {
        return;
      }

      if (
        leaveTarget instanceof HTMLButtonElement
        && this.isPlayModeLabel(this.getButtonLabel(leaveTarget))
      ) {
        return;
      }

      if (leaveTarget instanceof HTMLAnchorElement) {
        const href = String(leaveTarget.getAttribute("href") || "").trim().toLowerCase();
        const label = this.normalizeLabel(leaveTarget.textContent);
        const isCasinoHome = href === "/" || href === "/casino" || href.startsWith("/casino/");
        if (!isCasinoHome && label !== "casino") {
          return;
        }
      }

      this.exitSlot();
    },

    getActiveCurrency() {
      const selectors = [
        '#balance-button img[alt]',
        '.BalanceSelect_balanceBtn__a2IXa img[alt]',
      ];

      for (const selector of selectors) {
        const alt = String(document.querySelector(selector)?.getAttribute("alt") || "").trim().toUpperCase();
        if (alt && alt !== "ARROW") {
          return alt;
        }
      }

      const nonZero = State.balances.find((entry) => Number(entry?.amount) > 0);
      if (nonZero?.currency) {
        return String(nonZero.currency).toUpperCase();
      }

      return String(State.balances[0]?.currency || "SOL").toUpperCase();
    },

    getWalletUsdValue(currency = this.getActiveCurrency()) {
      const balance = Balance.get(currency);
      const usdAmount = CurrencyUsdRates.getUsdAmount(currency, balance, null);
      if (Number.isFinite(usdAmount) && usdAmount >= 0) {
        return usdAmount;
      }

      return Number.isFinite(balance) ? balance : 0;
    },

    getDemoBalanceText() {
      return formatUsdDisplay(this.getWalletUsdValue());
    },

    getSlotFrames() {
      return [...document.querySelectorAll(
        'div[class*="ProviderGame_root"] iframe, div[class*="SoftswissLoader_root"] iframe, [class*="ProviderGame"] iframe[src]'
      )];
    },

    isSlotOpen() {
      return this.getSlotFrames().length > 0;
    },

    postBalance(targetWindow, balanceText) {
      if (!targetWindow || targetWindow === window || !balanceText) {
        return;
      }

      try {
        targetWindow.postMessage({
          [__demoBalanceBridgeKey]: true,
          type: "BALANCE_SYNC",
          balanceText,
          balanceUsd: parseDisplayAmount(balanceText),
        }, "*");
      } catch (e) {
      }
    },

    broadcastDemoBalance() {
      const balanceText = this.getDemoBalanceText();
      if (!balanceText) {
        return;
      }

      const sent = new WeakSet();
      this.getSlotFrames().forEach((frame) => {
        const targetWindow = frame?.contentWindow;
        if (!targetWindow || sent.has(targetWindow)) {
          return;
        }

        sent.add(targetWindow);
        this.postBalance(targetWindow, balanceText);
      });
    },

    applyWalletBalanceFromDemoUsd(usdValue) {
      const currency = this.activeCurrency || this.getActiveCurrency();
      const numericUsd = Number(usdValue);
      if (!currency || !Number.isFinite(numericUsd) || numericUsd < 0) {
        return false;
      }

      const currentUsd = this.getWalletUsdValue(currency);
      if (Math.abs(currentUsd - numericUsd) < 0.005) {
        return true;
      }

      const usdRate = CurrencyUsdRates.getUsdRate(currency);
      if (Number.isFinite(usdRate) && usdRate > 0) {
        Balance.set(currency, numericUsd / usdRate);
        return true;
      }

      CurrencyUsdRates.refreshForCurrencies([currency]).then(() => {
        const refreshedRate = CurrencyUsdRates.getUsdRate(currency);
        if (Number.isFinite(refreshedRate) && refreshedRate > 0) {
          Balance.set(currency, numericUsd / refreshedRate);
        }
      }).catch(() => {});

      return false;
    },

    enterSlot() {
      this.sessionActive = true;
      this.activeCurrency = this.getActiveCurrency();
      this.lastDemoUsd = this.getWalletUsdValue(this.activeCurrency);
      CurrencyUsdRates.refreshForCurrencies([this.activeCurrency]).catch(() => {});
      this.setWalletHeaderPlaying();
      this.broadcastDemoBalance();
      this.syncPlayModeFooterHighlight();
      [0, 120, 350].forEach((delayMs) => {
        setTimeout(() => {
          this.setWalletHeaderPlaying();
          this.syncPlayModeFooterHighlight();
        }, delayMs);
      });
    },

    exitSlot() {
      if (!this.sessionActive || this.exitInProgress) {
        return;
      }

      this.exitInProgress = true;
      try {
        const demoUsd = Number.isFinite(this.lastDemoUsd)
          ? this.lastDemoUsd
          : this.getWalletUsdValue(this.activeCurrency || this.getActiveCurrency());
        this.applyWalletBalanceFromDemoUsd(demoUsd);
      } finally {
        this.sessionActive = false;
        this.activeCurrency = "";
        this.lastDemoUsd = null;
        this.syncPlayModeFooterHighlight();
        this.restoreWalletHeader();
        [0, 120, 350].forEach((delayMs) => {
          setTimeout(() => this.restoreWalletHeader(), delayMs);
        });
        setTimeout(() => {
          this.exitInProgress = false;
        }, 200);
      }
    },

    watchSlotPresence() {
      const open = this.isSlotOpen();

      if (open && this.sessionActive) {
        this.broadcastDemoBalance();
      }

      if (!open && this.sessionActive) {
        this.exitSlot();
      }
    },

    handleBridgeMessage(event) {
      const data = event?.data;
      if (!data || data[__demoBalanceBridgeKey] !== true) {
        return;
      }

      if (data.type === "REQUEST_BALANCE") {
        const balanceText = this.getDemoBalanceText();
        if (balanceText) {
          this.postBalance(event.source, balanceText);
        }
        return;
      }

      if (data.type === "LIVE_WAGER" || data.type === "LIVE_PAYOUT") {
        // Legacy delta messages — ignored. Live iframe sends absolute BALANCE_SYNC instead.
        return;
      }

      // Unified roulette bet book on Shuffle parent (mitmproxy has one process; TM needs this
      // so Gates multi-frame SoftSwiss traffic can settle like Speed Roulette).
      if (data.type === "LIVE_CASINO_BETS" || data.type === "LIVE_CASINO_RESULT" || data.type === "LIVE_CASINO_LUCKY") {
        if (!this.sessionActive) {
          this.enterSlot();
        }
        if (!this._liveRoulette) {
          this._liveRoulette = { bets: [], table: "", lucky: {}, bonusNumber: null, lastGid: "" };
        }
        const book = this._liveRoulette;
        if (data.type === "LIVE_CASINO_BETS") {
          if (data.cleared) {
            book.bets = [];
          } else if (Array.isArray(data.bets)) {
            book.bets = data.bets.map((b) => ({
              betCode: String(b.betCode),
              amount: Number(b.amount) || 0,
            }));
            if (data.table) {
              book.table = String(data.table);
            }
          }
          if (data.lucky && typeof data.lucky === "object") {
            book.lucky = { ...book.lucky, ...data.lucky };
          }
          if (data.bonusNumber != null) {
            book.bonusNumber = data.bonusNumber;
          }
        }
        if (data.type === "LIVE_CASINO_LUCKY") {
          if (data.lucky && typeof data.lucky === "object") {
            book.lucky = { ...book.lucky, ...data.lucky };
          }
          if (data.bonusNumber != null) {
            book.bonusNumber = data.bonusNumber;
          }
        }
        let relayPayload = data;
        if (data.type === "LIVE_CASINO_RESULT") {
          relayPayload = {
            ...data,
            bets: (book.bets && book.bets.length) ? book.bets.slice() : (data.bets || []),
            table: data.table || book.table || "",
            lucky: { ...book.lucky, ...(data.lucky || {}) },
            bonusNumber: data.bonusNumber != null ? data.bonusNumber : book.bonusNumber,
          };
          book.lastGid = String(data.gameId || data.resultNum || "");
          // Do not clear book here — settling frame sends LIVE_CASINO_BETS cleared:true
        }
        try {
          if (data.type === "LIVE_CASINO_BETS") {
            sessionStorage.setItem("larp_live_relay_bets", JSON.stringify(relayPayload));
          }
          if (data.type === "LIVE_CASINO_RESULT") {
            sessionStorage.setItem("larp_live_relay_result", JSON.stringify(relayPayload));
          }
        } catch (e) {
        }
        const sent = new WeakSet();
        this.getSlotFrames().forEach((frame) => {
          const targetWindow = frame?.contentWindow;
          if (!targetWindow || targetWindow === event.source || sent.has(targetWindow)) {
            return;
          }
          sent.add(targetWindow);
          try {
            targetWindow.postMessage(relayPayload, "*");
          } catch (e) {
          }
        });
        console.log("[LARP] Live casino relay", data.type, {
          bets: relayPayload.bets?.length,
          resultNum: relayPayload.resultNum,
          table: relayPayload.table,
          bookBets: book.bets.length,
        });
        return;
      }

      if (data.type === "BALANCE_UPDATE" || data.type === "BALANCE_SYNC") {
        const demoUsd = Number.isFinite(Number(data.balanceUsd))
          ? Number(data.balanceUsd)
          : parseDisplayAmount(data.balanceText);
        if (!Number.isFinite(demoUsd)) {
          return;
        }

        if (!this.sessionActive) {
          this.enterSlot();
        }

        this.lastDemoUsd = demoUsd;
        this.applyWalletBalanceFromDemoUsd(demoUsd);
        return;
      }
    },
  };


  const SportsBetSupport = {
    init() {
      SportsBetHistory.restorePendingSchedules();
      SportsBetHistory.startCashoutRefresh();
    },
  };

  const SportsSuccessToast = {
    show() {
      try {
        document.getElementById("larp-sports-success-toast")?.remove();
        const toast = document.createElement("div");
        toast.id = "larp-sports-success-toast";
        toast.setAttribute("role", "status");
        toast.style.cssText = "position:fixed;top:72px;right:16px;z-index:2147483646;min-width:280px;max-width:360px;background:#1c1c22;color:#e8e8ed;border-radius:10px;box-shadow:0 8px 28px rgba(0,0,0,.45);padding:14px 36px 14px 16px;font:600 14px/1.35 system-ui,Segoe UI,sans-serif;border-left:4px solid #2ecc71;pointer-events:auto";
        toast.innerHTML = '<div style="font-weight:700;margin-bottom:2px">Bet placed successfully</div><div style="font-weight:500;opacity:.85;font-size:13px">Your bet is open in My Bets</div><button type="button" aria-label="close" style="position:absolute;top:8px;right:10px;background:transparent;border:0;color:#9a9aa3;font-size:16px;cursor:pointer;line-height:1">x</button>';
        toast.querySelector("button")?.addEventListener("click", () => toast.remove());
        (document.body || document.documentElement).appendChild(toast);
        setTimeout(() => toast.remove(), 4200);
      } catch (e) {
      }
    },
  };

  const SportsPlaceUI = {
    findStore() {
      try {
        if (this._store?.dispatch && this._store?.getState?.()?.sportsBet) {
          return this._store;
        }
        for (const root of [document.getElementById("__next"), document.body].filter(Boolean)) {
          const key = Object.keys(root).find((name) => name.startsWith("__reactContainer") || name.startsWith("__reactFiber"));
          if (!key) continue;
          const queue = [root[key]];
          let visited = 0;
          while (queue.length && visited++ < 20000) {
            const fiber = queue.shift();
            if (!fiber || typeof fiber !== "object") continue;
            const store = fiber.memoizedProps?.store || fiber.memoizedProps?.value?.store || fiber.pendingProps?.store || fiber.stateNode?.store;
            if (store?.dispatch && store?.getState?.()?.sportsBet) {
              this._store = store;
              return store;
            }
            if (fiber.child) queue.push(fiber.child);
            if (fiber.sibling) queue.push(fiber.sibling);
            if (fiber.alternate) queue.push(fiber.alternate);
          }
        }
      } catch (e) {
      }
      return null;
    },

    onAccepted() {
      try {
        const store = this.findStore();
        store?.dispatch?.({ type: "sportsBet/changeBetSlipViewStage", payload: { betSlipViewStage: "BET_PLACED" } });
        store?.dispatch?.({ type: "sportsBet/setBetSlipPlacedError", payload: { errors: [] } });
        SportsSuccessToast.show();
      } catch (e) {
      }
    },
  };

  const SportsToastGuard = {
    needles: [
      "greater than your balance", "balance_not_enough", "balance not enough", "insufficient balance",
      "bet rejected", "max. stake exceeded", "max stake exceeded", "placing bets failed", "unable to place",
      "bet not accepted", "network error", "check your pending bets", "bet was processed",
      "there was an error placing your bet", "could not be placed", "pending bets to confirm", "bet_network_error",
    ],

    scrub() {
      try {
        document.querySelectorAll("[class*=toast],[class*=Toast],[class*=notification],[class*=Notification],[class*=alert],[class*=snack],[class*=Snack],[role='alert'],[role='status']").forEach((node) => {
          if (node.id === "larp-sports-success-toast") return;
          const text = String(node.textContent || "").toLowerCase().replace(/\s+/g, " ").trim();
          if (!text || text.length > 280 || !this.needles.some((needle) => text.includes(needle))) return;
          const toast = node.closest("[class*=toast],[class*=Toast],[class*=notification],[class*=Notification],[class*=alert],[class*=snack],[class*=Snack],[role='alert'],[role='status']") || node;
          toast.style.setProperty("display", "none", "important");
          toast.setAttribute("data-larp-toast-hidden", "1");
        });
      } catch (e) {
      }
    },

    init() {
      if (this._inited) return;
      this._inited = true;
      setInterval(() => this.scrub(), 350);
      new MutationObserver(() => this.scrub()).observe(document.documentElement, { childList: true, subtree: true });
    },
  };


  const LiveCasinoSupport = {
    broadcastTimer: null,
    lastSlug: "",

    isLiveGameSlug(slug) {
      return /roulette|blackjack|baccarat|game-show|live|gates-of-olympus-roulette|megawheel|sweet-bonanza-candy|monaco|sic-bo|olympus/i
        .test(String(slug || ""));
    },

    getActiveGameSlug() {
      try {
        const path = String(location.pathname || "");
        const m = path.match(/\/(?:casino|games|live-casino)\/([^/?#]+)/i)
          || path.match(/\/games\/([^/?#]+)/i);
        if (m && m[1]) {
          return decodeURIComponent(m[1]);
        }
      } catch (e) {
      }
      return this.lastSlug || "";
    },

    postGameContext(targetWindow, slug) {
      if (!targetWindow || targetWindow === window) {
        return;
      }
      const resolved = String(slug || this.getActiveGameSlug() || "");
      if (!resolved) {
        return;
      }
      try {
        targetWindow.postMessage({
          [__demoBalanceBridgeKey]: true,
          type: "GAME_CONTEXT",
          slug: resolved,
          gameSlug: resolved,
          title: document.title || "",
        }, "*");
      } catch (e) {
      }
    },

    broadcastGameContext(slug) {
      const resolved = String(slug || this.getActiveGameSlug() || "");
      if (resolved) {
        this.lastSlug = resolved;
      }
      const sent = new WeakSet();
      SlotSupport.getSlotFrames().forEach((frame) => {
        const targetWindow = frame?.contentWindow;
        if (!targetWindow || sent.has(targetWindow)) {
          return;
        }
        sent.add(targetWindow);
        this.postGameContext(targetWindow, resolved);
      });
    },

    init() {
      if (!__isShuffleHost) {
        return;
      }

      document.addEventListener("click", (event) => this.handlePlayClick(event), true);
      this.startBroadcastLoop();
    },

    handlePlayClick(event) {
      const target = event?.target;
      if (!(target instanceof Element) || !event.isTrusted) {
        return;
      }

      const button = target.closest('button, [role="button"]');
      if (!(button instanceof Element)) {
        return;
      }

      if (!SlotSupport.isInProviderGameContext(button)) {
        return;
      }

      const label = SlotSupport.getButtonLabel(button);
      if (!SlotSupport.isRealPlayLabel(label) && !SlotSupport.isFunPlayLabel(label)) {
        return;
      }

      SlotSupport.enterSlot();
      const slug = this.getActiveGameSlug();
      [0, 200, 600, 1500, 3000, 6000].forEach((delayMs) => {
        setTimeout(() => {
          SlotSupport.broadcastDemoBalance();
          this.broadcastGameContext(slug);
        }, delayMs);
      });
    },

    startBroadcastLoop() {
      if (this.broadcastTimer) {
        return;
      }

      this.broadcastTimer = setInterval(() => {
        if (SlotSupport.sessionActive && SlotSupport.isSlotOpen()) {
          SlotSupport.broadcastDemoBalance();
          this.broadcastGameContext();
        }
      }, 1000);
    },

    onGameCreateSession(req) {
      const slug = req?.variables?.gameSlug || "";
      this.lastSlug = String(slug || "");
      SlotSupport.enterSlot();
      [0, 250, 800, 2000, 5000].forEach((delayMs) => {
        setTimeout(() => {
          SlotSupport.broadcastDemoBalance();
          this.broadcastGameContext(slug);
        }, delayMs);
      });
      console.log("[LARP] Provider session armed:", slug || "(unknown)");
    },
  };


  if (!localStorage.getItem('balances')) {
    localStorage.setItem('balances', JSON.stringify([]));
  }
  if (!localStorage.getItem('vault_balances')) {
    localStorage.setItem('vault_balances', JSON.stringify([]));
  }
  if (!localStorage.getItem('rakeback_balances')) {
    localStorage.setItem('rakeback_balances', JSON.stringify([]));
  }
  if (!localStorage.getItem('profile')) {
    localStorage.setItem('profile', JSON.stringify(CONFIG.DEFAULT_PROFILE));
  }
  if (!localStorage.getItem('bet_history')) {
    localStorage.setItem('bet_history', JSON.stringify([]));
  }
  if (!localStorage.getItem('notification_history')) {
    localStorage.setItem('notification_history', JSON.stringify([]));
  }
  if (!localStorage.getItem('deposit_history')) {
    localStorage.setItem('deposit_history', JSON.stringify([]));
  }
  if (!localStorage.getItem('withdraw_history')) {
    localStorage.setItem('withdraw_history', JSON.stringify([]));
  }

  State.init();
  DepositHistory.reconcileStoredTxIds();
  WithdrawHistory.reconcileStoredTxIds();
  WithdrawHistory.reconcilePendingWithdrawals();
  TransactionIdUI.init();
  Network.intercept();

  // Ensure there's initial balance for sports betting (USDT, SOL, BTC)
  if (!State.balances || State.balances.length === 0) {
    State.balances = [
      { currency: 'USDT', amount: 10000, wallet: 'main', vaultId: null },
      { currency: 'SOL', amount: 10000, wallet: 'main', vaultId: null },
      { currency: 'BTC', amount: 10000, wallet: 'main', vaultId: null }
    ];
    Storage.save(CONFIG.STORAGE_KEYS.balances, State.balances);
    console.log('[LARP] Initialized balances: USDT=10000, SOL=10000, BTC=10000');
  }

  const syncSportsBetQueryResponses = (currency = null, forcedStatus = null) => {
    try {
      const pendingOnly = forcedStatus ? [forcedStatus] : null;
      const effectiveCurrency = currency ? [currency] : null;
      const list = SportsBetHistory.getSportsBets(20, null, effectiveCurrency, pendingOnly);
      const count = SportsBetHistory.countBets(pendingOnly, effectiveCurrency);

      if (window.targetWs && typeof window.targetWs.injectResponse === 'function') {
        window.targetWs.injectResponse('GetSportsBets', {
          sportsBets: list,
        });
        window.targetWs.injectResponse('SportsBetsCount', {
          sportsBetsCount: count,
        });
      }

      const storageEvent = new StorageEvent('storage', {
        key: CONFIG.STORAGE_KEYS.sportsBetHistory,
        newValue: JSON.stringify(State.sportsBetHistory),
      });
      window.dispatchEvent(storageEvent);
      document.dispatchEvent(new CustomEvent('larp:sports:drawer:refresh', {
        detail: { bets: State.sportsBetHistory, pendingBets: list.nodes || [], count: State.sportsBetHistory.length, pendingCount: count }
      }));
      window.dispatchEvent(new CustomEvent('larp:pending-bets:update', {
        detail: { pendingBets: list.nodes || [], count: count }
      }));
      return { list, count };
    } catch (e) {
      console.error('[LARP] Error syncing sports bet query responses:', e);
      return null;
    }
  };
  window.syncSportsBetQueryResponses = syncSportsBetQueryResponses;

  // Force My Bets drawer to read from localStorage
  const refreshMyBetsDrawer = () => {
    try {
      const bets = JSON.parse(localStorage.getItem('sports_bet_history') || '[]');
      const pendingBets = bets.filter((bet) => String(bet?.status || '').toUpperCase() === 'PENDING');

      document.dispatchEvent(new CustomEvent('larp:sports:drawer:refresh', {
        detail: { bets, pendingBets, count: bets.length, pendingCount: pendingBets.length }
      }));

      window.dispatchEvent(new CustomEvent('larp:my-bets:update', {
        detail: { bets, pendingBets, count: bets.length, pendingCount: pendingBets.length }
      }));

      window.dispatchEvent(new CustomEvent('larp:pending-bets:update', {
        detail: { pendingBets, count: pendingBets.length }
      }));

      window.dispatchEvent(new StorageEvent('storage', {
        key: 'sports_bet_history',
        newValue: JSON.stringify(bets),
      }));

      console.log('[LARP] My Bets drawer refresh triggered with', bets.length, 'bets and', pendingBets.length, 'pending bets');
    } catch (e) {
      console.error('[LARP] Error refreshing My Bets:', e);
    }
  };
  window.refreshMyBetsDrawer = refreshMyBetsDrawer;

  const injectPendingBetMarkup = (pendingBets = []) => {
    if (!Array.isArray(pendingBets)) return '';
    if (!pendingBets.length) {
      return '<div class="larp-empty-pending" style="padding:12px;color:#aaa;">No pending bets</div>';
    }
    return pendingBets.map((b) => {
      const payout = Number(b?.payout || 0);
      const odds = b?.totalOdds || b?.totalOddsDecimal || '1';
      return `<div class="larp-pending-bet" style="padding:10px;border:1px solid #333;margin:5px;background:#1a1a1a;color:#fff;">
        <strong>${String(b?.currency || 'USDT').toUpperCase()}</strong> - ${Number(b?.amount || 0)}
        <div>Odds: ${odds}x | Payout: ${payout}</div>
        <span style="color:#f90; font-weight:bold;">PENDING</span>
      </div>`;
    }).join('');
  };

  // Aggressive My Bets drawer injection
  window.injectBetsIntoMyBetsDrawer = () => {
    try {
      const bets = JSON.parse(localStorage.getItem('sports_bet_history') || '[]');
      const pendingBets = bets.filter((bet) => String(bet?.status || '').toUpperCase() === 'PENDING');

      const myBetsTab = document.querySelector('[data-testid="my-bets"], #my-bets, [class*="MyBets"]');
      if (myBetsTab) {
        if (myBetsTab.disabled) {
          myBetsTab.disabled = false;
          myBetsTab.setAttribute('aria-selected', 'true');
        }
        myBetsTab.click();
      }

      const betsContainer = document.querySelector('[class*="Bets"], [class*="bets"], [role="tabpanel"], [data-testid*="bets"]');
      if (betsContainer) {
        const visibleBets = bets.map((b) =>
          `<div class="larp-bet" style="padding:10px;border:1px solid #333;margin:5px;background:#1a1a1a;color:#fff;">
            <strong>${String(b?.currency || 'USDT').toUpperCase()}</strong> - ${Number(b?.amount || 0)} (Odds: ${b?.totalOdds || b?.totalOddsDecimal || '1'}x)
            <span style="color:${b.status === 'WON' ? '#0f0' : b.status === 'PENDING' ? '#f90' : '#f00'}">${String(b?.status || 'PENDING')}</span>
          </div>`
        ).join('');

        const pendingMarkup = injectPendingBetMarkup(pendingBets);
        const container = betsContainer.querySelector('.larp-bets-container') || betsContainer.querySelector('[class*="list"]') || betsContainer;
        container.innerHTML = `
          <div class="larp-bets-container" style="display:block;">
            <div style="padding:8px 0; color:#fff; font-weight:bold;">Pending Bets (${pendingBets.length})</div>
            ${pendingMarkup}
            <div style="padding:8px 0; color:#fff; font-weight:bold; margin-top:12px;">All Bets (${bets.length})</div>
            ${visibleBets || '<div style="padding:12px;color:#aaa;">No bets</div>'}
          </div>
        `;
      }

      return { injected: bets.length, pendingInjected: pendingBets.length, success: true };
    } catch (e) {
      console.error('[LARP] Error injecting bets into drawer:', e);
      return { error: e.message };
    }
  };
  window.injectPendingBetsIntoMyBetsDrawer = () => window.injectBetsIntoMyBetsDrawer();
  window.injectBetsIntoMyBetsDrawer();

  // MUST be true before sports bets are placed
  __interceptorReady = true;

  DepositSimulator.init();
  ShuffleDepositBridge.start();
  MoonPaySimulator.init();
  SlotSupport.init();
  SportsBetSupport.init();
  SportsToastGuard.init();
  LiveCasinoSupport.init();

  window.__larpBuild = "9.04-dynamic-deposit-receivers";
  window.TransactionIdUI = TransactionIdUI;
  window.Rakeback = Rakeback;
  window.VipRewards = VipRewards;
  window.SportsBetHistory = SportsBetHistory;
  window.SlotSupport = SlotSupport;
  window.LiveCasinoSupport = LiveCasinoSupport;
  console.log("[LARP] Loaded build:", window.__larpBuild);

  window.DepositSimulator = DepositSimulator;
  window.MoonPaySimulator = MoonPaySimulator;
  window.SwappedBuySimulator = SwappedBuySimulator;
  window.Network = Network;

  window.restartInterception = () => {
    window.fetch = __stubbedFetch;
    window.fetch.__larpIntercepted = true;
  };

  window.testDeposit = (currency = 'SOL', amount = 1) => {
    DepositSimulator.handleDeposit(currency, amount);
  };

  window.checkState = () => {
    return State;
  };

  const RichPlayerWatcher = {
    players: new Map(),
    minVipLevel: "PLATINUM_1",
    maxVipLevel: "SAPPHIRE_5",
    maxPlayers: 200,
    busy: false,
    lastRaceWagers: [],
    lastHighRollerBets: [],

    vipIndex(level) {
      const normalized = String(level || "").trim().toUpperCase();
      return CONFIG.VIP_LEVELS.findIndex((entry) => entry.level === normalized);
    },

    isExcludedRichVip(level) {
      const normalized = String(level || "").trim().toUpperCase();
      if (!normalized) {
        return true;
      }
      if (normalized.startsWith("RUBY")) {
        return true;
      }
      if (normalized.startsWith("DIAMOND")) {
        return true;
      }
      if (normalized.startsWith("OPAL")) {
        return true;
      }
      if (normalized.startsWith("DRAGON")) {
        return true;
      }
      return normalized === "MYTHIC" || normalized === "DARK" || normalized === "LEGEND";
    },

    isWatchedVip(level) {
      const normalized = String(level || "").trim().toUpperCase();
      if (!normalized || normalized === "UNRANKED" || normalized === "WOOD") {
        return false;
      }
      if (this.isExcludedRichVip(normalized)) {
        return false;
      }
      const index = this.vipIndex(normalized);
      const minIndex = this.vipIndex(this.minVipLevel);
      return index >= 0 && minIndex >= 0 && index >= minIndex;
    },

    isRichVip(level) {
      if (this.isExcludedRichVip(level)) {
        return false;
      }
      const index = this.vipIndex(level);
      const minIndex = this.vipIndex(this.minVipLevel);
      const maxIndex = this.vipIndex(this.maxVipLevel);
      if (index < 0 || minIndex < 0 || maxIndex < 0) {
        return false;
      }
      const low = Math.min(minIndex, maxIndex);
      const high = Math.max(minIndex, maxIndex);
      return index >= low && index <= high;
    },

    remember(entry) {
      const username = String(entry?.username || "").trim();
      if (!username) {
        return;
      }

      const vipLevel = String(entry?.vipLevel || "UNRANKED").trim().toUpperCase();
      if (!this.isWatchedVip(vipLevel)) {
        return;
      }

      const key = username.toLowerCase();
      const previous = this.players.get(key) || {};
      this.players.set(key, {
        username,
        vipLevel,
        usdWagered: entry.usdWagered ?? previous.usdWagered ?? null,
        xp: entry.xp ?? previous.xp ?? null,
        raceWagered: entry.raceWagered ?? previous.raceWagered ?? null,
        amount: entry.amount ?? previous.amount ?? null,
        seenAt: Date.now(),
        source: entry.source || previous.source || "watch",
      });

      if (this.players.size <= this.maxPlayers) {
        return;
      }

      const oldest = [...this.players.entries()].sort(
        (a, b) => Number(a[1].seenAt || 0) - Number(b[1].seenAt || 0)
      );
      const removeCount = this.players.size - this.maxPlayers;
      for (let i = 0; i < removeCount; i++) {
        this.players.delete(oldest[i][0]);
      }
    },

    observePayload(payloadData) {
      if (!payloadData || typeof payloadData !== "object") {
        return;
      }

      for (const key of ["highRollerBetUpdated", "latestBetUpdated"]) {
        const bet = payloadData[key];
        if (bet && typeof bet === "object") {
          this.remember({ ...bet, source: key });
        }
      }
    },

    async graphql(operationName, query, variables = {}) {
      const response = await __nativeFetch(CONFIG.GRAPHQL_ENDPOINT, {
        method: "POST",
        credentials: "include",
        headers: {
          "content-type": "application/json",
          accept: "application/json",
        },
        body: JSON.stringify({ operationName, query, variables }),
      });

      if (!response.ok) {
        throw new Error(`GraphQL HTTP ${response.status}`);
      }

      const json = await response.json();
      if (Array.isArray(json?.errors) && json.errors.length > 0) {
        throw new Error(json.errors[0]?.message || "GraphQL error");
      }

      return json?.data;
    },

    async refreshFromRace() {
      const data = await this.graphql(
        "GetRaceLeaderBoardV2",
        `query GetRaceLeaderBoardV2 {
          raceLeaderBoardV2 {
            raceWager { vipLevel username wagered raceId raceEntryId }
          }
        }`
      );

      const wagers = Array.isArray(data?.raceLeaderBoardV2?.raceWager)
        ? data.raceLeaderBoardV2.raceWager
        : [];
      this.lastRaceWagers = wagers;

      for (const row of wagers) {
        this.remember({
          username: row?.username,
          vipLevel: row?.vipLevel,
          raceWagered: row?.wagered,
          source: "race",
        });
      }

      return wagers.length;
    },

    async refreshFromHighRollers() {
      const data = await this.graphql(
        "GetHighRollerBets",
        `query GetHighRollerBets($count: Int, $isShflOnly: Boolean) {
          highRollerBets(count: $count, isShflOnly: $isShflOnly) {
            id
            username
            vipLevel
            currency
            amount
            payout
            multiplier
            gameName
          }
        }`,
        { count: 100, isShflOnly: false }
      );

      const bets = Array.isArray(data?.highRollerBets) ? data.highRollerBets : [];
      this.lastHighRollerBets = bets;
      for (const bet of bets) {
        this.remember({ ...bet, source: "highRollers" });
      }

      return bets.length;
    },

    async fetchUserProfile(username) {
      const data = await this.graphql(
        "GetUserProfile",
        `query GetUserProfile($username: String!) {
          user(username: $username) {
            id
            username
            vipLevel
            createdAt
            bets
            usdWagered
            moderatorRole
            xp
          }
        }`,
        { username }
      );

      return data?.user || null;
    },

    getRichCandidates() {
      return [...this.players.values()].filter((player) => this.isRichVip(player.vipLevel));
    },

    collectFreshPickableCandidates() {
      const map = new Map();

      const add = (username, vipLevel, extra = {}) => {
        const normalizedUsername = String(username || "").trim();
        const normalizedVip = String(vipLevel || "").trim().toUpperCase();
        if (!normalizedUsername || !this.isRichVip(normalizedVip)) {
          return;
        }
        const key = normalizedUsername.toLowerCase();
        map.set(key, {
          username: normalizedUsername,
          vipLevel: normalizedVip,
          ...extra,
        });
      };

      for (const row of this.lastRaceWagers) {
        add(row?.username, row?.vipLevel, { raceWagered: row?.wagered, source: "race" });
      }
      for (const bet of this.lastHighRollerBets) {
        add(bet?.username, bet?.vipLevel, { amount: bet?.amount, source: "highRollers" });
      }

      return [...map.values()];
    },

    buildCandidatePool() {
      const merged = new Map();
      for (const player of [...this.getRichCandidates(), ...this.collectFreshPickableCandidates()]) {
        const key = String(player.username || "").toLowerCase();
        if (!key) {
          continue;
        }
        merged.set(key, { ...merged.get(key), ...player });
      }
      return [...merged.values()];
    },

    estimateWageredForVip(vipLevel) {
      const index = this.vipIndex(vipLevel);
      const tier = CONFIG.VIP_LEVELS[index];
      const next = CONFIG.VIP_LEVELS[index + 1];
      const min = Number(tier?.amount || 2300000);
      const max = Number(next?.amount || min * 1.25);
      return min + Math.random() * Math.max(0, (max - min) * 0.85);
    },

    parseBetCount(value) {
      if (value == null || value === "") {
        return null;
      }

      const normalized = String(value).replace(/,/g, "").trim();
      const parsed = Number(normalized);
      if (!Number.isFinite(parsed) || parsed < 0) {
        return null;
      }

      return Math.floor(parsed);
    },

    estimateBetsForWagered(usdWagered) {
      const wagered = Number(usdWagered);
      if (!Number.isFinite(wagered) || wagered <= 0) {
        return null;
      }

      const avgBetUsd = 75;
      return Math.max(1000, Math.floor(wagered / avgBetUsd));
    },

    applyProfile({ username, vipLevel, usdWagered, xp, bets = null, createdAt = null }) {
      const normalizedUsername = String(username || "").trim();
      const normalizedVip = String(vipLevel || "SAPPHIRE_1").trim().toUpperCase();
      const wageredValue = Number(usdWagered);
      const xpValue = Number(xp);
      const betsValue = this.parseBetCount(bets);

      if (!normalizedUsername) {
        throw new Error("Missing username");
      }

      __preferredUsername = normalizedUsername;
      State.profile.username = normalizedUsername;
      State.profile.vipLevel = normalizedVip;
      State.profile.usdWagered = String(Number.isFinite(wageredValue) ? wageredValue : 0);
      State.profile.xp = Number.isFinite(xpValue) ? xpValue : Number(State.profile.usdWagered) || 0;
      State.profile.bets = betsValue ?? this.estimateBetsForWagered(State.profile.usdWagered);
      State.profile.createdAt = createdAt ? String(createdAt) : null;
      State.totalWagered = Number(State.profile.usdWagered) || 0;
      Rakeback.clear();
      Storage.save(CONFIG.STORAGE_KEYS.profile, State.profile);
      WebSocketInjector.injectVipLevelUpdate();

      const betsLabel = State.profile.bets != null ? State.profile.bets.toLocaleString() : "n/a";
      const joinedLabel = State.profile.createdAt || "n/a";
      console.log(
        `[LARP] Rich profile applied: @${normalizedUsername} | ${normalizedVip} | wagered $${Number(State.profile.usdWagered).toLocaleString()} | xp ${Number(State.profile.xp).toLocaleString()} | bets ${betsLabel} | joined ${joinedLabel}`
      );
    },

    async pickAndApply() {
      if (this.busy) {
        console.log("[LARP] Rich player search already running...");
        return null;
      }

      this.busy = true;
      console.log("[LARP] Searching for a random Platinum-Sapphire high roller...");

      try {
        await Promise.allSettled([
          this.refreshFromRace(),
          this.refreshFromHighRollers(),
        ]);

        let candidates = this.buildCandidatePool();
        console.log(`[LARP] Rich player pool: ${candidates.length} Platinum-Sapphire candidates`);
        if (candidates.length === 0) {
          console.error("[LARP] No Platinum-Sapphire players found. Check Weekly Race leaderboard, then retry.");
          console.error(`[LARP] Debug: race rows=${this.lastRaceWagers.length}, highrollers=${this.lastHighRollerBets.length}, watched=${this.players.size}`);
          return null;
        }

        candidates = candidates.sort((a, b) => {
          const vipDiff = this.vipIndex(b.vipLevel) - this.vipIndex(a.vipLevel);
          if (vipDiff !== 0) {
            return vipDiff;
          }
          return Number(b.raceWagered || b.amount || 0) - Number(a.raceWagered || a.amount || 0);
        });

        const poolSize = Math.max(3, Math.min(candidates.length, Math.ceil(candidates.length / 2)));
        const pool = candidates.slice(0, poolSize);

        for (let attempt = 0; attempt < Math.min(pool.length, 6); attempt++) {
          const pick = pool[Math.floor(Math.random() * pool.length)];

          let profile = null;
          try {
            profile = await this.fetchUserProfile(pick.username);
          } catch (error) {
            console.warn("[LARP] GetUserProfile failed, using watched race/high-roller data:", error);
          }

          const username = profile?.username || pick.username;
          const vipLevel = String(profile?.vipLevel || pick.vipLevel || "SAPPHIRE_1").trim().toUpperCase();
          if (!this.isRichVip(vipLevel)) {
            continue;
          }

          let usdWagered = Number(profile?.usdWagered);
          let xp = Number(profile?.xp);
          if (!Number.isFinite(usdWagered) || usdWagered <= 0) {
            usdWagered = this.estimateWageredForVip(vipLevel);
          }
          if (!Number.isFinite(xp) || xp <= 0) {
            xp = usdWagered;
          }

          const bets = this.parseBetCount(profile?.bets);
          const createdAt = profile?.createdAt || null;

          this.applyProfile({
            username,
            vipLevel,
            usdWagered,
            xp,
            bets,
            createdAt,
          });
          return { username, vipLevel, usdWagered, xp, bets, createdAt };
        }

        console.error(`[LARP] Found ${candidates.length} Platinum-Sapphire candidates but could not apply one. Retry in a few seconds.`);
        return null;
      } catch (error) {
        console.error("[LARP] Rich player search failed:", error);
        return null;
      } finally {
        this.busy = false;
      }
    },

    warmCache() {
      Promise.allSettled([
        this.refreshFromRace(),
        this.refreshFromHighRollers(),
      ]).then(([raceResult, highResult]) => {
        const raceCount = raceResult.status === "fulfilled" ? raceResult.value : 0;
        const highCount = highResult.status === "fulfilled" ? highResult.value : 0;
        const pickable = this.buildCandidatePool().length;
        console.log(
          `[LARP] Rich player watcher ready (${pickable} Platinum-Sapphire pickable, ${this.players.size} watched, race=${raceCount}, highrollers=${highCount})`
        );
      });
    },
  };

  window.RichPlayerWatcher = RichPlayerWatcher;
  if (__isShuffleHost) {
    setTimeout(() => RichPlayerWatcher.warmCache(), 2500);
  }

  const ChatCommands = {
    init() {
      this.hookChatInput();
    },

    hookChatInput() {
      const attachIfNeeded = () => {
        const input = document.querySelector('.Input_root__lWEbp');
        if (input && !input.dataset.larpHooked) {
          input.dataset.larpHooked = 'true';
          this.attachListener(input);
        }
      };

      // Check immediately
      attachIfNeeded();

      // Keep checking periodically
      setInterval(attachIfNeeded, 1000);
    },

    attachListener(input) {
      input.addEventListener('keydown', (e) => {
        if (e.key === 'Enter' && input.value.startsWith('/')) {
          e.preventDefault();
          e.stopPropagation();

          const command = input.value.trim();
          this.handleCommand(command);
          input.value = '';
        }
      });
    },

    handleCommand(command, options = {}) {
      const parts = command.split(/\s+/);
      const cmd = parts[0].toLowerCase();
      const args = parts.slice(1);

      switch(cmd) {
        case '/clearbets':
          State.betHistory = [];
          Storage.save(CONFIG.STORAGE_KEYS.betHistory, []);
          console.log('[LARP] Bet history cleared');
          break;

        case '/clearwithdraw':
          WithdrawHistory.clear();
          console.log('[LARP] Withdrawal history cleared');
          break;

        case '/clearnoti':
          State.notificationHistory = [];
          Storage.save(CONFIG.STORAGE_KEYS.notificationHistory, []);
          NotificationHistory.notifications = [];
          console.log('[LARP] Notification history cleared');
          break;

        case '/cleardepo':
          State.depositHistory = [];
          Storage.save(CONFIG.STORAGE_KEYS.depositHistory, []);
          DepositHistory.deposits = [];
          console.log('[LARP] Deposit history cleared');
          break;

        case '/cleartips':
          TipHistory.clear();
          console.log('[LARP] Tip / rain history cleared');
          break;

        case '/clearsportsbets':
          SportsBetHistory.clear();
          console.log('[LARP] Sports bet history cleared');
          break;

        case '/depo':
          if (args.length < 2) {
            console.error('[LARP] Usage: /depo <CURRENCY> <AMOUNT>');
            console.error('[LARP] Example: /depo SOL 10');
            break;
          }
          const currency = args[0].toUpperCase();
          const amount = parseFloat(args[1]);

          if (isNaN(amount) || amount <= 0) {
            console.error('[LARP] Invalid amount:', args[1]);
            break;
          }

          if (!CONFIG.CURRENCY_TO_CHAIN[currency]) {
            console.error('[LARP] Unknown currency:', currency);
            console.error('[LARP] Available currencies:', Object.keys(CONFIG.CURRENCY_TO_CHAIN).join(', '));
            break;
          }

          console.log(`[LARP] Depositing ${amount} ${currency}...`);
          DepositSimulator.handleDeposit(currency, amount, {
            creditBalance: options.creditDepositBalance !== false,
          });
          break;

        case '/moonpay':
        case '/swapped':
        case '/buycrypto': {
          console.log('[LARP] Buy Crypto → Swapped (real widget; fake card/phone accepted)');
          SwappedBuySimulator.open();
          break;
        }

        case '/withdraw':
          if (args.length < 2) {
            console.error('[LARP] Usage: /withdraw <CURRENCY> <AMOUNT>');
            console.error('[LARP] Example: /withdraw SOL 10');
            break;
          }
          const withdrawCurrency = args[0].toUpperCase();
          const withdrawAmount = parseFloat(args[1]);

          if (isNaN(withdrawAmount) || withdrawAmount <= 0) {
            console.error('[LARP] Invalid amount:', args[1]);
            break;
          }

          if (!CONFIG.CURRENCY_TO_CHAIN[withdrawCurrency]) {
            console.error('[LARP] Unknown currency:', withdrawCurrency);
            console.error('[LARP] Available currencies:', Object.keys(CONFIG.CURRENCY_TO_CHAIN).join(', '));
            break;
          }

          const currentBalance = Balance.get(withdrawCurrency);
          if (withdrawAmount > currentBalance) {
            console.error('[LARP] Insufficient balance');
            break;
          }

          Balance.set(withdrawCurrency, currentBalance - withdrawAmount);
          const withdrawTimestamp = new Date().toISOString();
          const manualWithdrawId = BetHistory.generateId();
          const manualConfirmationDelayMs = WithdrawHistory.getConfirmationDelayMs();
          const manualConfirmAt = new Date(Date.now() + manualConfirmationDelayMs).toISOString();
          WithdrawHistory.addWithdraw({
            id: manualWithdrawId,
            chain: CONFIG.CURRENCY_TO_CHAIN[withdrawCurrency] || 'UNKNOWN',
            currency: withdrawCurrency,
            amount: withdrawAmount,
            usdAmount: withdrawAmount,
            createdAt: withdrawTimestamp,
            confirmAt: manualConfirmAt,
            status: 'PENDING',
          });
          WithdrawHistory.scheduleConfirmation(manualWithdrawId, manualConfirmationDelayMs);
          console.log(`[LARP] Withdrawal: ${withdrawAmount} ${withdrawCurrency}`);
          break;

        case '/balance':
          if (args.length === 0) {
            console.log('[LARP] Current balances:');
            State.balances.forEach(b => {
              console.log(`  ${b.currency}: ${b.amount}`);
            });
          } else {
            const curr = args[0].toUpperCase();
            const bal = Balance.get(curr);
            console.log(`[LARP] ${curr}: ${bal}`);
          }
          break;

        case '/setbalance':
          if (args.length < 2) {
            console.error('[LARP] Usage: /setbalance <CURRENCY> <AMOUNT>');
            break;
          }
          const setCurr = args[0].toUpperCase();
          const setAmt = parseFloat(args[1]);

          if (isNaN(setAmt) || setAmt < 0) {
            console.error('[LARP] Invalid amount:', args[1]);
            break;
          }

          Balance.set(setCurr, setAmt);
          console.log(`[LARP] Set ${setCurr} balance to ${setAmt}`);
          break;

        case '/setusername':
        case '/setuser':
          if (args.length < 1) {
            console.error('[LARP] Usage: /setusername <USERNAME>');
            console.error('[LARP] Example: /setusername Kasu');
            console.error('[LARP] Example: /setuser rich');
            break;
          }
          {
            const rawName = args.join(' ').replace(/^<|>$/g, '').trim();
            if (!rawName) {
              console.error('[LARP] Invalid username');
              break;
            }

            if (rawName.toLowerCase() === 'rich') {
              void RichPlayerWatcher.pickAndApply();
              break;
            }

            State.profile.username = rawName;
            __preferredUsername = rawName;
            Storage.save(CONFIG.STORAGE_KEYS.profile, State.profile);
            console.log(`[LARP] Username set to ${rawName}`);
          }
          break;

        case '/clearbalances':
        case '/clear':
          if (cmd === '/clear' && String(args[0] || '').toLowerCase() !== 'balances') {
            console.error('[LARP] Usage: /clear balances');
            break;
          }
          {
            const walletCurrencies = State.balances.map((b) => b.currency);
            for (const currency of walletCurrencies) {
              Balance.set(currency, 0);
            }
            const vaultCurrencies = State.vaultBalances.map((b) => b.currency);
            for (const currency of vaultCurrencies) {
              Vault.set(currency, 0);
            }
            console.log('[LARP] All balances cleared');
          }
          break;

        case '/resetprofile':
        case '/reset':
          if (cmd === '/reset' && String(args[0] || '').toLowerCase() !== 'profile') {
            console.error('[LARP] Usage: /reset profile');
            break;
          }
          {
            __preferredUsername = __defaultUsername;
            State.profile = {
              ...CONFIG.DEFAULT_PROFILE,
              username: __defaultUsername,
              vipLevel: "UNRANKED",
              xp: 0,
              usdWagered: "0",
              bets: null,
              createdAt: null,
            };
            State.totalWagered = 0;
            Rakeback.clear();
            Storage.save(CONFIG.STORAGE_KEYS.profile, State.profile);
            WebSocketInjector.injectVipLevelUpdate();
            console.log(`[LARP] Profile reset to default (@${__defaultUsername}, UNRANKED)`);
          }
          break;

        case '/rakeback':
          {
            const claimable = Rakeback.getClaimable();
            const theoretical = Rakeback.theoreticalFromUsdWagered(State.totalWagered);
            console.log('[LARP] Rakeback status:');
            console.log(`  eligible: ${Rakeback.isEligible()}`);
            console.log(`  lifetime theoretical (~1% HE * 5%): $${theoretical.toFixed(4)}`);
            console.log(`  claimable USD: $${Rakeback.getClaimableUsd().toFixed(4)}`);
            if (claimable.length === 0) {
              console.log('  claimable balances: (none)');
            } else {
              claimable.forEach((entry) => {
                console.log(`  ${entry.currency}: ${entry.amount}`);
              });
            }
            console.log('  Claim from the VIP page Instant Rakeback button, or it will credit on ClaimRakebacks.');
          }
          break;

        case '/roulette':
          if (args.length === 0) {
            const active = State.rouletteLandingNumber ?? CONFIG.ROULETTE_LANDING_NUMBER;
            if (active === null || active === undefined || active === "") {
              console.log('[LARP] Roulette landing: random');
            } else {
              console.log('[LARP] Roulette landing forced to:', active);
            }
            break;
          }
          {
            const target = args.join(' ').trim().toLowerCase();
            if (target === 'random' || target === 'off' || target === 'clear') {
              State.rouletteLandingNumber = null;
              console.log('[LARP] Roulette landing set to random');
              break;
            }
            if (target === 'green' || target === '0') {
              State.rouletteLandingNumber = 0;
              console.log('[LARP] Roulette landing forced to green (0)');
              break;
            }
            const parsed = Number(target);
            if (!Number.isFinite(parsed) || parsed < 0 || parsed > 36) {
              console.error('[LARP] Usage: /roulette <0-36|green|random>');
              console.error('[LARP] Example: /roulette 14');
              break;
            }
            State.rouletteLandingNumber = Math.floor(parsed);
            console.log(`[LARP] Roulette landing forced to ${State.rouletteLandingNumber}`);
          }
          break;

        case '/help':
          console.log('[LARP] Available commands:');
          console.log('  /clearbets - Clear bet history');
          console.log('  /clearwithdraw - Clear withdrawal history');
          console.log('  /clearnoti - Clear notification history');
          console.log('  /cleardepo - Clear deposit history');
          console.log('  /cleartips - Clear tip / rain history');
          console.log('  /clearsportsbets - Clear sports bet history');
          console.log('  /clear balances - Clear all wallet and vault balances');
          console.log('  /reset profile - Reset username, VIP, XP, and wagered to default');
          console.log('  /rakeback - Show claimable rakeback balances');
          console.log('  /roulette <0-36|green|random> - Force roulette landing number');
          console.log('  /depo <CURRENCY> <AMOUNT> - Simulate deposit');
          console.log('  /swapped - Focus Buy Crypto (real Swapped widget; fake card accepted)');
          console.log('  /buycrypto - Alias for /swapped');
          console.log('  /moonpay - Alias for /swapped');
          console.log('  /withdraw <CURRENCY> <AMOUNT> - Simulate withdrawal');
          console.log('  /tip <USERNAME> <AMOUNT> <CURRENCY> - Simulate receiving a tip');
          console.log('  /balance [CURRENCY] - Show balance(s)');
          console.log('  /setbalance <CURRENCY> <AMOUNT> - Set balance directly');
          console.log('  /setusername <USERNAME> - Change LARP username');
          console.log('  /setuser rich - Mock a random Platinum-Sapphire high roller');
          console.log('  /help - Show this help message');
          break;

        case '/tip':
          if (args.length < 3) {
            console.error('[LARP] Usage: /tip <USERNAME> <AMOUNT> <CURRENCY>');
            console.error('[LARP] Example: /tip celetsu 0.5 SOL');
            break;
          }
          {
            const tipSender = args[0];
            const tipAmt = parseFloat(args[1]);
            const tipCurr = args[2].toUpperCase();

            if (isNaN(tipAmt) || tipAmt <= 0) {
              console.error('[LARP] Invalid amount:', args[1]);
              break;
            }

            // Add to balance
            const tipCurrentBal = Balance.get(tipCurr) || 0;
            Balance.set(tipCurr, tipCurrentBal + tipAmt);

            TipHistory.addReceivedTip({
              currency: tipCurr,
              amount: String(tipAmt),
              senderUsername: tipSender,
              createdAt: new Date().toISOString(),
            });

            // Inject balanceUpdated via WebSocket
            if (window.targetWs) {
              window.targetWs.injectResponse('BalanceUpdated', {
                balanceUpdated: {
                  currency: tipCurr,
                  amount: String(tipCurrentBal + tipAmt),
                  windowId: null,
                  __typename: "BalanceSubscriptionData"
                }
              });

              // Inject tipReceived subscription event â€” triggers the native alert notification
              window.targetWs.injectResponse('tipReceived', {
                tipReceived: {
                  senderUsername: tipSender,
                  tipType: "DIRECT",
                  currency: tipCurr,
                  amount: String(tipAmt),
                  __typename: "TipReceived"
                }
              });

            }

            console.log(`[LARP] Tip received: ${tipAmt} ${tipCurr} from @${tipSender}`);
          }
          break;

        default:
          console.error('[LARP] Unknown command:', cmd);
          console.log('[LARP] Type /help for available commands');
      }
    }
  };

  ChatCommands.init();

  const CrashDomPatcher = {
    init() {
      document.addEventListener("click", (event) => this.handleClick(event), true);
      setInterval(() => this.patchUI(), 300);
    },

    isCrashPage() {
      return /\/games\/originals\/crash/i.test(window.location.pathname);
    },

    patchUI() {
      if (!this.isCrashPage()) {
        return;
      }
      const crashBet = State.currentCrashBet;
      const amount = Number(crashBet?.amount || 0);
      if (!(amount > 0)) {
        return;
      }
      const username = State.profile?.username || __preferredUsername;
      const formattedAmount = `$${amount.toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
      document.querySelectorAll("span.FiatWithTooltip_root__DNH9i, span.fiat-with-tool-tip-text, [class*='FiatWithTooltip']").forEach((node) => {
        if (!["$0.00", "$0.000", "$0"].includes(node.textContent.trim())) {
          return;
        }
        let parent = node.parentElement;
        for (let index = 0; index < 8 && parent; index++, parent = parent.parentElement) {
          if (parent.textContent.includes(username)) {
            node.textContent = formattedAmount;
            break;
          }
        }
      });
    },

    handleClick(event) {
      if (!this.isCrashPage()) {
        return;
      }
      const crashBet = State.currentCrashBet;
      if (!crashBet || State.resolvedCrashBetIds.includes(crashBet.betId) || !(event.target instanceof Element)) {
        return;
      }
      const button = event.target.closest("button, [role='button'], div[class*='cashout' i]");
      const text = String(button?.textContent || "").toLowerCase().replace(/[\s,$.]/g, "");
      if (!button || (!text.includes("cashout") && !text.includes("cash") && !String(button.className).toLowerCase().includes("cashout"))) {
        return;
      }
      const multiplier = Number(State.currentCrashState?.currentPoint || 0) > 1
        ? Number(State.currentCrashState.currentPoint)
        : 2;
      Handlers.resolveCrashPayout({
        betId: crashBet.betId,
        currency: crashBet.currency,
        amount: crashBet.amount,
        multiplier,
        crashGameId: crashBet.crashGameId || State.currentCrashState?.crashGameId || null,
      });
    },
  };

  CrashDomPatcher.init();

  // Tip form bypass â€” suppress balance errors and force-enable tip functionality
  // Limbo DOM patcher â€” force win display only for high targets (FORCE_LIMBO_WIN_MIN+)
  (function limboResultDomPatcher() {
    if (!CONFIG.FORCE_LIMBO_WIN) return;

    var lastSig = "";
    var winClassCache = null;
    var minForce = CONFIG.FORCE_LIMBO_WIN_MIN || 300;

    function findWinClass() {
      if (winClassCache) return winClassCache;
      try {
        var sheets = document.styleSheets;
        for (var i = 0; i < sheets.length; i++) {
          var rules;
          try { rules = sheets[i].cssRules || sheets[i].rules; } catch (e) { continue; }
          if (!rules) continue;
          for (var j = 0; j < rules.length; j++) {
            var sel = rules[j].selectorText || "";
            var match = sel.match(/\.?(LimboResult_win__[A-Za-z0-9_-]+)/);
            if (match) {
              winClassCache = match[1];
              return winClassCache;
            }
          }
        }
      } catch (e) {}
      return null;
    }

    function formatMulti(n, target, isWin) {
      var display = GameLogic.formatLimboDisplayResult(n, target, isWin);
      return display.toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 }) + "x";
    }

    function parseTarget(root) {
      var input = root.querySelector('input[readonly][value], input[readonly]');
      if (input) {
        var v = parseFloat(String(input.value || "").replace(/,/g, ""));
        if (Number.isFinite(v) && v > 0) return v;
      }
      var fromState = Number(State.currentGame?.multiplier || State.currentGame?.limboData?.multiplier || 0);
      return Number.isFinite(fromState) && fromState > 0 ? fromState : 0;
    }

    function patchResultSpan(span, resultMulti, targetMulti) {
      if (!(span instanceof Element)) return;
      var text = formatMulti(resultMulti, targetMulti, true);
      if (span.textContent !== text) span.textContent = text;

      var winClass = findWinClass();
      var className = span.className || "";
      if (/LimboResult_loss__/.test(className)) {
        if (winClass) {
          span.className = className.replace(/LimboResult_loss__[A-Za-z0-9_-]+/g, winClass);
        } else {
          span.className = className.replace(/LimboResult_loss__/g, "LimboResult_win__");
          span.style.color = "#2cbf6d";
        }
      } else if (!/LimboResult_win__/.test(className)) {
        span.style.color = "#2cbf6d";
      }
    }

    function patchMultiplierCell(root, targetMulti) {
      var cell = root.querySelector('[class*="MultiplierCell_root"]');
      if (!cell) return;
      var valueSpan = cell.querySelector('span:last-child') || cell;
      var text = formatMulti(targetMulti);
      cell.querySelectorAll('span').forEach(function(node) {
        if (/^\d/.test((node.textContent || "").trim()) || /x$/i.test((node.textContent || "").trim())) {
          if (node.textContent !== text) node.textContent = text;
        }
        if (node.className && /MultiplierCell_greyOut__/.test(node.className)) {
          node.className = node.className.replace(/MultiplierCell_greyOut__[A-Za-z0-9_-]+/g, "").trim();
        }
      });
      var img = cell.querySelector("img");
      if (img && /decrease/i.test(img.getAttribute("src") || "")) {
        img.setAttribute("src", (img.getAttribute("src") || "").replace("multi-decrease", "multi-increase"));
        img.setAttribute("alt", "increase");
        img.className = (img.className || "").replace(/MultiplierCell_greyOut__[A-Za-z0-9_-]+/g, "").trim();
      }
    }

    function patchPayoutLose(root) {
      root.querySelectorAll('[class*="BetInfoModal_lose"]').forEach(function(node) {
        node.className = (node.className || "").replace(/BetInfoModal_lose__[A-Za-z0-9_-]+/g, "").trim();
        node.style.color = "#2cbf6d";
      });
    }

    function patchResultSpanLoss(span, resultMulti) {
      if (!(span instanceof Element)) return;
      var text = formatMulti(resultMulti);
      if (span.textContent !== text) span.textContent = text;
      var className = span.className || "";
      if (/LimboResult_win__/.test(className)) {
        span.className = className.replace(/LimboResult_win__/g, "LimboResult_loss__");
      }
      span.style.color = "";
    }

    function patchRoot(root) {
      if (!(root instanceof Element)) return;
      var target = parseTarget(root);
      if (!(target >= minForce)) return;

      var last = State.limboForceLast;
      var lastMatches = last
        && Math.abs(Number(last.targetMulti) - target) < 0.001
        && (Date.now() - Number(last.at || 0)) < 20000;
      if (!lastMatches) return;

      var resultSpans = root.querySelectorAll('[class*="LimboResult_loss"], [class*="LimboResult_limboResultMultiplier"] span, [class*="LimboResult_win"]');
      if (!resultSpans.length) {
        resultSpans = document.querySelectorAll('[class*="LimboResult_loss"], [class*="LimboResult_win"]');
      }
      if (!resultSpans.length) return;

      var resultMulti = Number(last.resultMulti);
      if (!(resultMulti > 0)) return;
      var displayMulti = last.isWin
        ? GameLogic.formatLimboDisplayResult(resultMulti, target, true)
        : resultMulti;

      var sig = target + "|" + displayMulti + "|" + (last.isWin ? "W" : "L");
      if (sig === lastSig) {
        // Still re-check if UI flipped back to the wrong outcome.
        var mismatch = false;
        resultSpans.forEach(function(span) {
          var shown = parseFloat(String(span.textContent || "").replace(/[x,]/gi, ""));
          if (!(Math.abs(shown - displayMulti) < 0.01)) mismatch = true;
          if (last.isWin && /LimboResult_loss__/.test(span.className || "")) mismatch = true;
          if (!last.isWin && /LimboResult_win__/.test(span.className || "")) mismatch = true;
        });
        if (!mismatch) return;
      }
      lastSig = sig;

      if (last.isWin) {
        resultSpans.forEach(function(span) {
          patchResultSpan(span, resultMulti, target);
        });
        patchMultiplierCell(root, target);
        patchPayoutLose(root);
      } else {
        resultSpans.forEach(function(span) {
          patchResultSpanLoss(span, resultMulti);
        });
      }
    }

    function scan() {
      try {
        var modal = document.querySelector('[data-testid="modal-content-bet"]');
        if (modal) patchRoot(modal);

        var liveNode = document.querySelector('[class*="LimboResult_loss"], [class*="LimboResult_win"]');
        if (liveNode) {
          var liveRoot = liveNode.closest('[class*="Limbo"]') || liveNode.parentElement || document.body;
          patchRoot(liveRoot);
        }
      } catch (e) {}
    }

    setInterval(scan, 250);
    if (typeof MutationObserver !== "undefined") {
      var start = function() {
        if (!document.body) return;
        new MutationObserver(scan).observe(document.body, { childList: true, subtree: true, characterData: true });
      };
      if (document.body) start();
      else document.addEventListener("DOMContentLoaded", start);
    }
  })();

  (function tipFormBypass() {
    function fixTipForm() {
      try {
        // Force-enable disabled Send Tip buttons
        document.querySelectorAll('button[disabled]').forEach(function(btn) {
          var text = (btn.textContent || '').trim().toLowerCase();
          if (text === 'send tip') {
            btn.disabled = false;
            btn.removeAttribute('disabled');
          }
        });

        // Remove "greater than" / "insufficient balance" error toasts globally
        document.querySelectorAll('[class*="Toastify"] [role="alert"], [class*="toast"], [class*="Toast"]').forEach(function(el) {
          var text = el.textContent || '';
          if (text.includes('greater than') || text.includes('insufficient') || text.includes('Insufficient') || text.includes('exceeds') || text.includes('Invalid amount') || text.includes('invalid amount')) {
            el.style.display = 'none';
            try { el.remove(); } catch(e) {}
          }
        });
      } catch(e) {}
    }

    // Suppress balance validation errors
    setInterval(fixTipForm, 500);
  })();

  // Baccarat DOM observer â€” reads win/loss from card points and pays out
  (function baccaratResultObserver() {
    var lastBacResult = '';
    var observer = new MutationObserver(function() {
      try {
        if (!State._pendingBacBet) return;
        if (!window.location.pathname.includes('/baccarat')) return;

        // Look for the points elements with win/lose classes
        var pointsEls = document.querySelectorAll('[data-testid="points"]');
        if (pointsEls.length < 2) return;

        // Find which one has "Win" class and which has "Lose" class
        var playerPoints = null, bankerPoints = null;
        var playerWon = false, bankerWon = false, isTie = false;

        // The elements are in order: first = Player, second = Banker
        var containers = document.querySelectorAll('.BaccaratCardContainer_points__wTPU_');
        if (containers.length < 2) return;

        var playerEl = containers[0];
        var bankerEl = containers[1];

        var playerClass = playerEl.className || '';
        var bankerClass = bankerEl.className || '';

        // Check if result is showing (win/lose classes present)
        if (!playerClass.includes('pointsWin') && !playerClass.includes('pointsLose') && !playerClass.includes('pointsTie')) return;

        playerPoints = parseInt(playerEl.textContent) || 0;
        bankerPoints = parseInt(bankerEl.textContent) || 0;

        if (playerClass.includes('pointsWin')) playerWon = true;
        else if (bankerClass.includes('pointsWin')) bankerWon = true;
        if (playerClass.includes('pointsTie') || bankerClass.includes('pointsTie')) isTie = true;

        // Determine outcome
        var outcome = isTie ? 'TIE' : playerWon ? 'PLAYER_WIN' : 'BANKER_WIN';

        // Create a unique signature to avoid double-processing
        var sig = outcome + '_' + playerPoints + '_' + bankerPoints;
        if (sig === lastBacResult) return;
        lastBacResult = sig;

        var pending = State._pendingBacBet;
        State._pendingBacBet = null;

        // Calculate payout based on what we bet
        var totalPayout = 0;
        pending.bets.forEach(function(b) {
          if (b.type === 'PLAYER' && outcome === 'PLAYER_WIN') totalPayout += b.amount * 2;
          else if (b.type === 'PLAYER' && outcome === 'TIE') totalPayout += b.amount; // push
          else if (b.type === 'BANKER' && outcome === 'BANKER_WIN') totalPayout += b.amount * 1.95;
          else if (b.type === 'BANKER' && outcome === 'TIE') totalPayout += b.amount; // push
          else if (b.type === 'TIE' && outcome === 'TIE') totalPayout += b.amount * 9;
          else if (b.type === 'PLAYER_PAIR') totalPayout += 0; // TODO: detect pairs from DOM
          else if (b.type === 'BANKER_PAIR') totalPayout += 0;
        });

        // Update balance with payout
        if (totalPayout > 0) {
          var currentBal = Balance.get(pending.currency) || 0;
          Balance.set(pending.currency, currentBal + totalPayout);

          // Show the cashout overlay popup (centered in game area, with animation)
          var usdRate = CurrencyUsdRates.getUsdRate(pending.currency);
          var usdPayout = (Number.isFinite(usdRate) && usdRate > 0) ? (totalPayout * usdRate) : totalPayout;
          var multiplier = pending.wager > 0 ? totalPayout / pending.wager : 0;
          var formattedPayout = '$' + usdPayout.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
          var iconSlug = pending.currency.toLowerCase();

          var existing = document.querySelector('[data-larp-cashout]');
          if (existing) existing.remove();

          // Find the game container to center within
          var gameContainer = document.querySelector('[class*="BaccaratGame"], [class*="baccarat_game"], [class*="GameContent"]') || document.body;
          var containerRect = gameContainer.getBoundingClientRect();

          var overlay = document.createElement('button');
          overlay.setAttribute('data-testid', 'cashout-overlay');
          overlay.setAttribute('data-larp-cashout', 'true');
          overlay.type = 'button';
          overlay.className = 'cashoutOverlay_cashoutCard__u65DN cashoutOverlay_cashoutCardShow__CKa2q';
          overlay.style.cssText = 'position:absolute;top:50%;left:50%;transform:translate(-50%,-50%) scale(0);z-index:9999;opacity:0;transition:transform 0.3s cubic-bezier(0.34,1.56,0.64,1),opacity 0.2s ease;';
          overlay.innerHTML = '<p class="cashoutOverlay_cashoutOverlayMultiplier__UQ1Mr">x' + multiplier.toFixed(2) + '</p>' +
            '<div class="cashoutOverlay_cashoutOverlayPayout__YLZlt"><div class="cashoutOverlay_textContainer__JbjkH">' +
            '<img class="CryptoIcon_root__FVB7K CryptoIcon_image__1494s" alt="' + pending.currency + '" width="16" height="16" src="/icons/crypto/' + iconSlug + '.svg">' +
            '<span>' + formattedPayout + '</span></div></div>';
          overlay.onclick = function() { overlay.remove(); };

          // Insert into game container (or body with fixed positioning)
          var targetParent = gameContainer.style.position ? gameContainer : document.body;
          if (targetParent === document.body) {
            overlay.style.position = 'fixed';
          } else {
            gameContainer.style.position = 'relative';
          }
          targetParent.appendChild(overlay);

          // Trigger animation
          requestAnimationFrame(function() {
            overlay.style.transform = 'translate(-50%,-50%) scale(1)';
            overlay.style.opacity = '1';
          });

          // Play win sound
          try {
            var audio = new Audio('/sounds/win.mp3');
            audio.volume = 0.5;
            audio.play().catch(function() {});
          } catch(e) {}

          // Auto-remove after 3 seconds with fade out
          setTimeout(function() {
            try {
              overlay.style.transform = 'translate(-50%,-50%) scale(0.8)';
              overlay.style.opacity = '0';
              setTimeout(function() { try { overlay.remove(); } catch(e) {} }, 300);
            } catch(e) {}
          }, 2700);
        }
      } catch(e) {}
    });

    var startObserving = function() {
      if (document.body) {
        observer.observe(document.body, { childList: true, subtree: true, attributes: true, attributeFilter: ['class'] });
      } else {
        setTimeout(startObserving, 100);
      }
    };
    startObserving();
  })();

  // Slide payout DOM observer â€” watches for the cashout overlay and adds payout to balance
  (function slidePayoutObserver() {
    var lastPayoutText = '';
    var observer = new MutationObserver(function() {
      try {
        // Only run on Slide page
        if (!window.location.pathname.includes('/slide')) return;

        var payoutEl = document.querySelector('.cashoutOverlay_cashoutOverlayPayout__YLZlt span');
        if (!payoutEl) return;

        var text = (payoutEl.textContent || '').trim();
        if (!text || text === lastPayoutText) return;
        lastPayoutText = text;

        // Parse the dollar amount from text like "$103.20"
        var match = text.match(/\$?([\d,]+\.?\d*)/);
        if (!match) return;

        var usdPayout = parseFloat(match[1].replace(/,/g, '')) || 0;
        if (usdPayout <= 0) return;

        // Get current active currency and convert USD to coin
        var currency = State.currentGame.currency;
        if (!currency) {
          var iconEl = document.querySelector('.cashoutOverlay_cashoutOverlayPayout__YLZlt img');
          if (iconEl) currency = (iconEl.alt || '').toUpperCase();
        }
        if (!currency) currency = 'SOL';

        var usdRate = CurrencyUsdRates.getUsdRate(currency);
        var coinPayout = usdPayout;
        if (Number.isFinite(usdRate) && usdRate > 0) {
          coinPayout = usdPayout / usdRate;
        }

        // Add payout to balance instantly
        var currentBal = Balance.get(currency) || 0;
        Balance.set(currency, currentBal + coinPayout);
      } catch(e) {}
    });

    var startObserving = function() {
      if (document.body) {
        observer.observe(document.body, { childList: true, subtree: true });
      } else {
        setTimeout(startObserving, 100);
      }
    };
    startObserving();
  })();

  // === BALANCE SYNC WITH LIVE CASINO PROXY ===
  // Periodically sends current balance to the proxy so live casino stays in sync
  (function balanceSync() {
    setInterval(function() {
      try {
        if (typeof Balance === 'undefined' || typeof State === 'undefined') return;
        // Get the primary currency balance (SOL or whatever is active)
        var currency = State.currentGame && State.currentGame.currency ? State.currentGame.currency : 'SOL';
        var coinBal = Balance.get(currency) || 0;
        var usdRate = typeof CurrencyUsdRates !== 'undefined' ? CurrencyUsdRates.getUsdRate(currency) : 0;
        var usdBal = (Number.isFinite(usdRate) && usdRate > 0) ? coinBal * usdRate : coinBal;

        // Send to proxy sync endpoint
        fetch('https://shuffle.com/__balance_sync', {
          method: 'POST',
          headers: {'content-type': 'application/json'},
          body: JSON.stringify({balance: usdBal, currency: currency, coinBalance: coinBal})
        }).then(function(r) { return r.json(); }).then(function(data) {
          // If live casino changed the balance, update ours
          if (data && data.balance && Math.abs(data.balance - usdBal) > 1) {
            var newCoinBal = (Number.isFinite(usdRate) && usdRate > 0) ? data.balance / usdRate : data.balance;
            Balance.set(currency, newCoinBal);
          }
        }).catch(function() {});
      } catch(e) {}
    }, 5000); // Sync every 5 seconds
  })();

})();
