(() => {
	const rect = (e) => {
		if (!e) return null;
		const r = e.getBoundingClientRect();
		return Object.fromEntries(
			["x", "y", "width", "height", "top", "right", "bottom", "left"].map(
				(k) => [k, Math.round(r[k] * 100) / 100],
			),
		);
	};
	const intersect = (a, b) => ({
		left: Math.max(a.left, b.left),
		top: Math.max(a.top, b.top),
		right: Math.min(a.right, b.right),
		bottom: Math.min(a.bottom, b.bottom),
	});
	const clipped = (e) => {
		const ownStyle = getComputedStyle(e);
		if (
			ownStyle.display === "none" ||
			ownStyle.visibility === "hidden" ||
			Number(ownStyle.opacity) === 0
		)
			return { width: 0, height: 0 };
		const r = intersect(e.getBoundingClientRect(), {
			left: 0,
			top: 0,
			right: innerWidth,
			bottom: innerHeight,
		});
		for (let p = e.parentElement; p; p = p.parentElement) {
			const s = getComputedStyle(p),
				pr = p.getBoundingClientRect();
			if (["hidden", "clip", "scroll", "auto"].includes(s.overflowX)) {
				r.left = Math.max(r.left, pr.left);
				r.right = Math.min(r.right, pr.right);
			}
			if (["hidden", "clip", "scroll", "auto"].includes(s.overflowY)) {
				r.top = Math.max(r.top, pr.top);
				r.bottom = Math.min(r.bottom, pr.bottom);
			}
			if (
				s.display === "none" ||
				s.visibility === "hidden" ||
				Number(s.opacity) === 0
			)
				return { width: 0, height: 0 };
		}
		return {
			width: Math.max(0, r.right - r.left),
			height: Math.max(0, r.bottom - r.top),
		};
	};
	const text = (e) => e?.textContent.replace(/\s+/g, " ").trim() || "";
	const fullyVisible = (r, c) =>
		r.width > 0 &&
		r.height > 0 &&
		c.width >= r.width - 1 &&
		c.height >= r.height - 1;
	const rows = [...document.querySelectorAll(".hq-away .incidents .inc")].map(
		(e) => {
			const s = getComputedStyle(e),
				r = rect(e),
				c = clipped(e),
				tops = [];
			const walker = document.createTreeWalker(e, NodeFilter.SHOW_TEXT);
			for (let n = walker.nextNode(); n; n = walker.nextNode()) {
				if (!n.textContent.trim()) continue;
				const range = document.createRange();
				range.selectNodeContents(n);
				for (const b of range.getClientRects())
					if (b.width && b.height && !tops.some((t) => Math.abs(t - b.top) < 2))
						tops.push(b.top);
			}
			return {
				text: text(e),
				rect: r,
				visible: c,
				lineHeight: parseFloat(s.lineHeight),
				lineTops: tops,
				oneLine: tops.length === 1 && r.height <= parseFloat(s.lineHeight) + 1,
				fullyVisible: fullyVisible(r, c),
			};
		},
	);
	const cards = [...document.querySelectorAll(".cards .card")].map((e) => {
		const r = rect(e),
			c = clipped(e);
		return {
			text: text(e),
			rect: r,
			visible: c,
			fullyVisible: fullyVisible(r, c),
		};
	});
	const fonts = [];
	for (const e of document.querySelectorAll(".board *")) {
		const own = [...e.childNodes].filter(
			(n) => n.nodeType === Node.TEXT_NODE && n.textContent.trim(),
		);
		if (!own.length) continue;
		const c = clipped(e),
			s = getComputedStyle(e);
		if (
			c.width <= 0 ||
			c.height <= 0 ||
			s.visibility === "hidden" ||
			Number(s.opacity) === 0
		)
			continue;
		fonts.push({
			tag: e.tagName,
			class: e.className,
			text: own
				.map((n) => n.textContent)
				.join(" ")
				.trim()
				.slice(0, 160),
			size: parseFloat(s.fontSize),
			weight: s.fontWeight,
			rect: rect(e),
		});
	}
	const columns = [...document.querySelectorAll(".board-body > *")].map(
		(e) => ({ class: e.className, rect: rect(e) }),
	);
	const hq = document.querySelector(".hq"),
		now = document.querySelector(".now"),
		history = document.querySelector(".hq-away");
	const inside = (r) =>
		r &&
		r.left >= -1 &&
		r.top >= -1 &&
		r.right <= innerWidth + 1 &&
		r.bottom <= innerHeight + 1;
	const overlap = (a, b) =>
		Math.min(a.right, b.right) - Math.max(a.left, b.left) > 1 &&
		Math.min(a.bottom, b.bottom) - Math.max(a.top, b.top) > 1;
	const demo = new URLSearchParams(location.search).get("demo") === "1";
	const sizes = [...new Set(fonts.map((f) => f.size))].sort((a, b) => a - b);
	const allowed = (s) =>
		s === 48 || (s >= 24 && s <= 28) || (s >= 16 && s <= 18);
	const metrics = {
		at: new Date().toISOString(),
		url: location.href,
		viewport: { width: innerWidth, height: innerHeight, dpr: devicePixelRatio },
		scroll: {
			width: document.documentElement.scrollWidth,
			height: document.documentElement.scrollHeight,
		},
		columns,
		hq: rect(hq),
		now: rect(now),
		history: rect(history),
		historyClip: history ? clipped(history) : null,
		rows,
		historyFullyVisible: rows.filter((r) => r.fullyVisible).length,
		broadIncidentSelectorCount:
			document.querySelectorAll(".incidents .inc").length,
		cards,
		cardsFullyVisible: cards.filter((c) => c.fullyVisible).length,
		nowCount: document.querySelectorAll(".now-run").length,
		fonts,
		sizes,
		weights: [...new Set(fonts.map((f) => f.weight))],
		sentence: text(document.querySelector(".board-sentence")),
		demoLabels: [...document.querySelectorAll(".demo-band")].map(text),
		scene: document.querySelector(".tiles")
			? "2d"
			: document.querySelector(".campus canvas, .town-stage canvas")
				? "3d"
				: "pending",
		canvas: [
			...document.querySelectorAll(".campus canvas, .town-stage canvas"),
		].map((e) => ({
			width: e.width,
			height: e.height,
			rect: rect(e),
		})),
		tiles: [...document.querySelectorAll(".tiles > li")].map((e) => ({
			text: text(e),
			rect: rect(e),
		})),
		machineText: [...document.querySelectorAll(".bm")].map(text),
		ua: navigator.userAgent,
	};
	const checks = [];
	const check = (name, pass, value) =>
		checks.push({ name, status: pass ? "PASS" : "FAIL", value });
	check(
		"columns_320_300",
		columns.length === 3 &&
			Math.abs(columns[0].rect.width - 320) < 1 &&
			Math.abs(columns[2].rect.width - 300) < 1,
		columns.map((c) => c.rect.width),
	);
	if (innerWidth === 1920)
		check(
			"village_at_least_60_percent",
			columns[1]?.rect.width / innerWidth >= 0.6,
			columns[1]?.rect.width / innerWidth,
		);
	if (innerWidth === 1920)
		check(
			"no_scroll_and_hq_now_in_view",
			metrics.scroll.width <= innerWidth &&
				metrics.scroll.height <= innerHeight &&
				inside(metrics.hq) &&
				inside(metrics.now),
			{ scroll: metrics.scroll, hq: metrics.hq, now: metrics.now },
		);
	check(
		"columns_do_not_overlap",
		columns.length === 3 &&
			!columns.some((a, i) =>
				columns.slice(i + 1).some((b) => overlap(a.rect, b.rect)),
			),
		columns.map((c) => c.rect),
	);
	check(
		"font_three_tiers",
		fonts.length > 0 &&
			sizes.every(allowed) &&
			getComputedStyle(document.querySelector(".board-sentence")).fontSize ===
				"48px",
		sizes,
	);
	check(
		"font_at_most_two_weights",
		metrics.weights.length <= 2,
		metrics.weights,
	);
	check("history_at_most_six_rows", rows.length <= 6, rows.length);
	check(
		"history_one_line_per_row",
		rows.every((r) => r.oneLine),
		rows.map((r) => ({
			height: r.rect.height,
			lineHeight: r.lineHeight,
			lines: r.lineTops.length,
		})),
	);
	const historyVisibility = {
		total: rows.length,
		fullyVisible: metrics.historyFullyVisible,
		area: metrics.historyClip,
		requirement:
			innerWidth === 1920 ? "all_rows_visible" : "at_least_one_row_visible",
	};
	if (
		innerWidth === 1366 &&
		innerHeight === 768 &&
		demo &&
		rows.length > 0 &&
		metrics.historyFullyVisible === 0
	) {
		checks.push({
			name: "history_visibility",
			status: "KNOWN",
			value: {
				...historyVisibility,
				reason: "11 section 8: accepted 1366x768 demo history limit",
			},
		});
	} else {
		check(
			"history_visibility",
			rows.length === 0 ||
				(innerWidth === 1920
					? rows.every((r) => r.fullyVisible)
					: rows.some((r) => r.fullyVisible)),
			historyVisibility,
		);
	}
	check(
		"approval_cards_fully_visible",
		cards.every((c) => c.fullyVisible),
		{ total: cards.length, fullyVisible: metrics.cardsFullyVisible },
	);
	check("now_at_most_five", metrics.nowCount <= 5, metrics.nowCount);
	check(
		"demo_label",
		demo
			? metrics.demoLabels.length === 1 &&
					metrics.demoLabels[0] === "예시 데이터"
			: metrics.demoLabels.length === 0,
		metrics.demoLabels,
	);
	check("status_sentence", metrics.sentence.length > 0, metrics.sentence);
	// the town's minimap gives way to the 결재 cards (12 §3) but must not hide while the HQ column still has
	// room for it (owner review R1: MAP missing with space left under the column). Room = the empty height
	// under the column's last block; a map needs 64 px + its title and gaps (TownMinimap.tsx MIN_H).
	const townMap = document.querySelector(".town-map");
	if (document.querySelector(".town-stage canvas") && hq) {
		const shown =
			!!townMap &&
			!townMap.hidden &&
			townMap.getBoundingClientRect().height >= 64;
		const blocks = [...hq.children].filter(
			(e) => e !== townMap && getComputedStyle(e).display !== "none",
		);
		const last = blocks[blocks.length - 1];
		const pad = Number.parseFloat(getComputedStyle(hq).paddingBottom) || 0;
		const spare = last
			? Math.round(
					hq.getBoundingClientRect().bottom -
						pad -
						last.getBoundingClientRect().bottom,
				)
			: 0;
		check("town_minimap_not_hidden_with_room", shown || spare < 64 + 46, {
			mounted: !!townMap,
			shown,
			spare,
		});
	}
	return { metrics, checks };
})();
