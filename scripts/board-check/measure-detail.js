// The detail screen (#/detail, 16 A3), measured in the page: the board's panel look and its rules — no
// sideways scroll (the page and every panel), every text within 10.5–14 px × --ui, no absolute user path
// (`/Users/…`, `C:\Users\…`, `/home/…`) anywhere in the text or a tooltip. Then one session row is picked
// (a click on this screen only: it filters events already held, no request) and the same is checked on
// its terminal view. Read-only otherwise.
(async () => {
	const checks = [];
	const check = (name, ok, value) =>
		checks.push({ name, status: ok ? "PASS" : "FAIL", value });
	const frame = () =>
		new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r)));
	const root = document.querySelector(".detail");
	const ui =
		Number.parseFloat(
			getComputedStyle(root ?? document.body)
				.getPropertyValue("--ui")
				.trim(),
		) || 1;
	const allowed = (s) => s >= 10.5 * ui - 0.01 && s <= 14 * ui + 0.01;
	const USER_PATH =
		/(^|[^A-Za-z0-9])(\/Users\/|\/home\/|\/Volumes\/|\/root\/|\/var\/folders\/|[A-Za-z]:\\Users\\)|(^|[\s"'=:(,])~[A-Za-z0-9_]/;
	function measure(tag) {
		const fonts = [];
		for (const e of document.querySelectorAll(".detail *")) {
			const own = [...e.childNodes].filter(
				(n) => n.nodeType === 3 && n.textContent.trim(),
			);
			if (!own.length) continue;
			const r = e.getBoundingClientRect();
			const s = getComputedStyle(e);
			if (r.width <= 0 || r.height <= 0 || s.visibility === "hidden") continue;
			fonts.push({
				size: Number.parseFloat(s.fontSize),
				text: own[0].textContent.trim().slice(0, 40),
			});
		}
		const bad = fonts.filter((f) => !allowed(f.size));
		check(`detail_text_size_${tag}`, fonts.length > 0 && bad.length === 0, {
			ui,
			sizes: [...new Set(fonts.map((f) => f.size))].sort((a, b) => a - b),
			outside: bad.slice(0, 5),
		});
		// the board frame is fixed and clips: measure its parts, not only the page
		const page = [
			document.documentElement,
			...document.querySelectorAll(".detail-top, .detail-body"),
		].every((e) => e.scrollWidth <= e.clientWidth + 1);
		const wide = [
			...document.querySelectorAll(".detail .dpanel, .detail .dscroll"),
		]
			.filter((e) => e.scrollWidth > e.clientWidth + 1)
			.map((e) => e.className);
		check(`detail_no_horizontal_scroll_${tag}`, page && wide.length === 0, {
			page: document.documentElement.scrollWidth,
			viewport: innerWidth,
			wide,
		});
		const titles = [...document.querySelectorAll(".detail [title]")].map((e) =>
			e.getAttribute("title"),
		);
		const text = document.body.innerText;
		const hits = [text, ...titles].filter((t) => t && USER_PATH.test(t));
		check(`detail_no_user_path_${tag}`, hits.length === 0, {
			hits: hits.slice(0, 3).map((t) => t.slice(0, 80)),
		});
	}
	check(
		"detail_panels",
		!!root && document.querySelectorAll(".detail .dpanel").length === 4,
		{
			panels: [
				...document.querySelectorAll(".detail .dpanel .ptitle-text"),
			].map((e) => e.textContent),
		},
	);
	measure("all");
	// no live session: include the quiet and ended ones so a row can be picked
	if (!document.querySelector(".detail .drow")) {
		document.querySelector(".detail .dcheck input")?.click();
		await frame();
	}
	const row = document.querySelector(".detail .drow");
	if (row) {
		row.click();
		await frame();
		const term = document.querySelector(".detail .dterm");
		check(
			"detail_pick_session_terminal",
			!!term && row.getAttribute("aria-pressed") === "true",
			{
				lines: term ? term.children.length : 0,
			},
		);
		measure("picked");
		row.click(); // back to every event
		await frame();
	} else
		checks.push({
			name: "detail_pick_session_terminal",
			status: "KNOWN",
			value: "no session at all on this hub: the picked view was not measured",
		});
	return { checks };
})();
