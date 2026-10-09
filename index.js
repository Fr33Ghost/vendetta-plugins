(function () {
    // GifProviderSwitcher for Revenge (Classic / Vendetta-style plugin API).
    // Port of the Vencord plugin: intercepts Discord's own /gifs/* REST calls and answers them from Tenor or Giphy.
    // NOTE: the loader evaluates this file as `return <file>`, so it must start with the expression, not a comment.
    const { patcher, metro, ui, logger } = vendetta;
    const storage = vendetta.plugin.storage;   // per-plugin persistent settings
    const { findByProps, findByStoreName } = metro;
    const { React, ReactNative: RN } = metro.common;
    const { Forms } = ui.components;
    const { showToast } = ui.toasts;

    const TENOR_KEY = "3Z0688EVWYKH";                       // GBoard iOS key, same as the Vencord plugin
    const GIPHY_KEY = "Gc7131jiJuvI7IdN0HZ1D7nh0ow5BU6g";   // giphy.com website key, same as the Vencord plugin
    const PROVIDERS = [
        { value: "tenor", label: "Tenor" },
        { value: "giphy", label: "Giphy" },
        { value: "klipy", label: "Klipy (Discord default)" }
    ];

    // ---------- helpers ----------
    const qs = (params) =>
        Object.keys(params)
            .filter(k => params[k] != null && params[k] !== "")
            .map(k => encodeURIComponent(k) + "=" + encodeURIComponent(params[k]))
            .join("&");

    function getLocale() {
        try {
            const l = findByStoreName("LocaleStore")?.locale;
            if (typeof l === "string" && l) return l;
        } catch { }
        return "en-US";
    }

    async function getJson(url) {
        const res = await fetch(url);
        if (!res.ok) throw new Error("HTTP " + res.status + " for " + url.split("?")[0]);
        return res.json();
    }

    // Discord tells us what format it wants via the media_format query param
    // (e.g. "mp4", "webm", "tinywebp", "gif"). Mobile values are not documented, so be lenient.
    function wantedFormat(query) {
        const f = String(query?.media_format ?? "").toLowerCase();
        if (f.includes("webp")) return "webp";
        if (f.includes("mp4") || f.includes("webm")) return "video";
        return "gif";
    }

    const dedupe = (items) => [...new Map(items.map(i => [i.id, i])).values()];

    // ---------- Tenor (v1) ----------
    const tenor = {
        api(path, params) {
            return getJson("https://api.tenor.com/v1" + path + "?" + qs({
                key: TENOR_KEY,
                locale: getLocale().replace("-", "_").toLowerCase(),
                ...params
            }));
        },
        toGif(item, fmt) {
            const m = item.media?.[0];
            if (!m?.gif) return null;
            const pick = fmt === "video" ? m.tinywebm ?? m.mp4 : fmt === "webp" ? m.webp : m.gif;
            const media = pick ?? m.gif;
            return {
                id: item.id,
                title: item.title || item.h1_title || "",
                url: item.itemurl,
                gif_src: m.gif.url,
                src: media.url,
                width: media.dims[0],
                height: media.dims[1],
                preview: media.preview ?? m.gif.preview
            };
        },
        async list(path, limit, fmt, extra = {}) {
            const items = [];
            const seen = new Set();
            let pos = "";
            while (items.length < limit) {
                const { next, results = [] } = await this.api(path, {
                    ...extra, limit: Math.min(limit - items.length, 50), pos
                });
                const before = items.length;
                for (const r of results) {
                    if (seen.has(r.id)) continue;
                    seen.add(r.id);
                    const g = this.toGif(r, fmt);
                    if (g) items.push(g);
                    if (items.length >= limit) break;
                }
                if (items.length === before || !next || next === pos) break;
                pos = next;
            }
            return items;
        },
        search: (q, limit, fmt) => tenor.list("/search", limit, fmt, { q }),
        trending: (limit, fmt) => tenor.list("/trending", limit, fmt),
        suggestions: (q) => tenor.api("/search_suggestions", { q, limit: 5 }).then(r => r.results ?? []),
        share: (id, q) => tenor.api("/registershare", { id, q }).catch(() => { }),
        async categories() {
            const r = await this.api("/categories", { type: "featured" }).catch(() => null);
            if (!r?.tags?.length) return null;
            return {
                categories: r.tags.map(t => ({ name: t.searchterm, src: t.image })),
                gifs: [{ src: r.tags[0].image }]
            };
        }
    };

    // ---------- Giphy ----------
    const giphy = {
        api(path, params = {}) {
            const locale = getLocale().toLowerCase();
            const lang = locale.startsWith("zh")
                ? (locale.includes("tw") || locale.includes("hant") ? "zh-TW" : "zh-CN")
                : locale.split("-")[0];
            return getJson("https://api.giphy.com/v1" + path + "?" + qs({ api_key: GIPHY_KEY, lang, ...params }));
        },
        toGif(item, fmt) {
            const { original, fixed_height, fixed_height_still } = item.images ?? {};
            if (!original?.url || !fixed_height) return null;
            const src = fmt === "video" ? fixed_height.mp4 : fmt === "webp" ? fixed_height.webp : fixed_height.url;
            return {
                id: item.id,
                title: item.title,
                url: item.url,
                gif_src: original.url,
                src: src ?? fixed_height.url,
                width: Number(fixed_height.width),
                height: Number(fixed_height.height),
                preview: fixed_height_still?.url ?? original.url
            };
        },
        async list(path, limit, fmt, extra = {}) {
            const pages = await Promise.all(
                Array.from({ length: Math.ceil(limit / 50) }, (_, i) =>
                    this.api(path, { ...extra, limit: Math.min(50, limit - i * 50), offset: i * 50 }))
            );
            return dedupe(pages.flatMap(p => p.data ?? []).map(i => this.toGif(i, fmt)).filter(Boolean)).slice(0, limit);
        },
        search: (q, limit, fmt) => giphy.list("/gifs/search", limit, fmt, { q }),
        trending: (limit, fmt) => giphy.list("/gifs/trending", limit, fmt),
        suggestions: (q) => giphy.api("/gifs/search/tags", { q, limit: 5 }).then(r => r.data?.map(t => t.name) ?? []),
        share: async () => { },
        async categories() {
            const r = await this.api("/gifs/categories").catch(() => null);
            const categories = r?.data
                ?.map(c => ({ name: c.name, src: c.gif?.images?.fixed_height?.url }))
                .filter(c => c.src);
            if (!categories?.length) return null;
            return { categories, gifs: [{ src: categories[0].src }] };
        }
    };

    const providers = { tenor, giphy };
    const current = () => providers[storage.provider];

    // ---------- REST interception ----------
    let cachedCategories = null;
    let cachedFor = null;

    async function handle(route, opts, provider) {
        const query = opts?.query ?? {};
        const fmt = wantedFormat(query);
        switch (route) {
            case "search":
                return provider.search(String(query.q ?? ""), 100, fmt);
            case "trending-gifs":
                return provider.trending(50, fmt);
            case "suggest":
                return query.q ? provider.suggestions(String(query.q)) : [];
            case "trending": {
                if (!cachedCategories || cachedFor !== storage.provider) {
                    cachedCategories = await provider.categories();
                    cachedFor = storage.provider;
                }
                if (!cachedCategories) throw new Error("No categories");
                return cachedCategories;
            }
        }
    }

    // Matches "/gifs/search", "/v9/gifs/search?x" etc. Returns the route name or null.
    function routeOf(url) {
        const m = /(?:^|\/)gifs\/(search|suggest|trending-gifs|trending|select)\/?(?:\?|$)/.exec(String(url ?? ""));
        return m ? m[1] : null;
    }

    const urlOf = (arg) => (typeof arg === "string" ? arg : arg?.url);
    const optsOf = (arg) => (typeof arg === "string" ? {} : arg ?? {});

    const patches = [];

    function wrapRest(RestAPI, method) {
        if (typeof RestAPI?.[method] !== "function") return;
        patches.push(patcher.instead(method, RestAPI, async (args, orig) => {
            const route = routeOf(urlOf(args[0]));
            if (!route || storage.provider === "klipy" || !current()) return orig(...args);

            const provider = current();
            const opts = optsOf(args[0]);
            try {
                if (route === "select") {
                    // POST /gifs/select: Tenor wants a share ping, Giphy needs nothing.
                    provider.share(opts.body?.id, opts.body?.q);
                    return { ok: true, status: 204, headers: {}, body: undefined, text: "" };
                }
                const body = await handle(route, opts, provider);
                return { ok: true, status: 200, headers: {}, body, text: JSON.stringify(body) };
            } catch (e) {
                logger.error("Provider failed, falling back to Discord's own request", e);
                return orig(...args);
            }
        }));
    }

    // ---------- settings UI ----------
    function Settings() {
        vendetta.storage.useProxy(storage);
        const { FormSection, FormRadioRow, FormText } = Forms;
        return React.createElement(RN.ScrollView, null,
            React.createElement(FormSection, { title: "GIF provider", titleStyleType: "no_border" },
                PROVIDERS.map(p =>
                    React.createElement(FormRadioRow, {
                        key: p.value,
                        label: p.label,
                        selected: storage.provider === p.value,
                        onPress: () => {
                            storage.provider = p.value;
                            cachedCategories = null;
                            showToast("GIF provider: " + p.label);
                        }
                    }))),
            React.createElement(FormText, { style: { margin: 16, opacity: 0.7 } },
                "Close and reopen the GIF picker after switching so the trending categories reload."));
    }

    return {
        onLoad() {
            storage.provider ??= "tenor";
            const RestAPI = findByProps("getAPIBaseURL", "get") ?? findByProps("getAPIBaseURL");
            if (!RestAPI) {
                showToast("GifProviderSwitcher: could not find Discord's REST module");
                return;
            }
            wrapRest(RestAPI, "get");
            wrapRest(RestAPI, "post");
        },
        onUnload() {
            for (const unpatch of patches) unpatch();
            patches.length = 0;
            cachedCategories = null;
        },
        settings: Settings
    };
})()
