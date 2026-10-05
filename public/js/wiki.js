/* ============================================================
   STCraft Wiki 渲染脚本
   - 读取 location.hash 路由到 docs/*.md（如 #advanced/soulring）
   - 使用 marked 解析 Markdown；CDN 不可用时使用内置降级解析器
   - 生成侧栏高亮、本页目录、自定义附魔数据表
   ============================================================ */
(function () {
  "use strict";

  var DOCS = {
    index:    { file: "docs/index.md",    title: "Wiki 首页" },
    start:    { file: "docs/start.md",    title: "加入指南" },
    features: { file: "docs/features.md", title: "服务器特色" },
    gameplay: { file: "docs/gameplay.md", title: "玩法介绍" },
    advanced: { file: "docs/advanced.md", title: "进阶玩法" },
    rules:    { file: "docs/rules.md",    title: "服务器规则" },
    faq:      { file: "docs/faq.md",      title: "常见问题" }
  };
  var DEFAULT_DOC = "index";

  var contentEl, tocWrap, tocNavEl, crumbEl, sidebarEl;
  var cache = {};
  var current = { doc: "", anchor: "" };

  function $(id) { return document.getElementById(id); }

  /* ----------------------------------------------------------
     降级 Markdown 解析器（marked 加载失败时使用）
     支持：标题、段落、粗体/斜体/删除线、行内代码、代码块、
           链接、图片、列表、引用、表格、分隔线、原样 HTML
     ---------------------------------------------------------- */
  function miniMarkdown(src) {
    var lines = String(src).replace(/\r\n?/g, "\n").split("\n");
    var out = [], i = 0, para = [];

    function esc(t) {
      return t.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
    }

    function inline(t) {
      var codes = [];
      t = esc(t);
      t = t.replace(/`([^`]+)`/g, function (_, c) {
        codes.push(c);
        return "\u0000" + (codes.length - 1) + "\u0000";
      });
      t = t.replace(/!\[([^\]]*)\]\(([^)\s]+)\)/g, '<img alt="$1" src="$2">');
      t = t.replace(/\[([^\]]+)\]\(([^)\s]+)\)/g, '<a href="$2">$1</a>');
      t = t.replace(/\*\*([^*]+)\*\*/g, "<strong>$1</strong>");
      t = t.replace(/__([^_]+)__/g, "<strong>$1</strong>");
      t = t.replace(/\*([^*]+)\*/g, "<em>$1</em>");
      t = t.replace(/~~([^~]+)~~/g, "<del>$1</del>");
      t = t.replace(/\u0000(\d+)\u0000/g, function (_, n) {
        return "<code>" + codes[+n] + "</code>";
      });
      return t.replace(/\n/g, "<br>\n");
    }

    function flush() {
      if (para.length) {
        out.push("<p>" + inline(para.join("\n")) + "</p>");
        para = [];
      }
    }

    while (i < lines.length) {
      var line = lines[i];
      var t = line.trim();

      if (t === "") { flush(); i++; continue; }

      /* 代码块 */
      if (/^```/.test(t)) {
        flush(); i++;
        var buf = [];
        while (i < lines.length && !/^```/.test(lines[i].trim())) { buf.push(lines[i]); i++; }
        i++;
        out.push("<pre><code>" + esc(buf.join("\n")) + "</code></pre>");
        continue;
      }

      /* 标题 */
      var h = t.match(/^(#{1,6})\s+(.*)$/);
      if (h) {
        flush();
        var lv = h[1].length;
        out.push("<h" + lv + ">" + inline(h[2]) + "</h" + lv + ">");
        i++; continue;
      }

      /* 分隔线 */
      if (/^(-{3,}|\*{3,}|_{3,})$/.test(t)) {
        flush(); out.push("<hr>"); i++; continue;
      }

      /* 引用 */
      if (/^>/.test(t)) {
        flush();
        var q = [];
        while (i < lines.length && /^>/.test(lines[i].trim())) {
          q.push(lines[i].trim().replace(/^>\s?/, ""));
          i++;
        }
        out.push("<blockquote><p>" + inline(q.join("\n")) + "</p></blockquote>");
        continue;
      }

      /* 表格（当前行含 | 且下一行是分隔行） */
      var next = i + 1 < lines.length ? lines[i + 1].trim() : "";
      if (t.indexOf("|") !== -1 && /^[\s:|-]+$/.test(next) && next.indexOf("-") !== -1) {
        flush();
        function splitRow(s) {
          return s.replace(/^\|/, "").replace(/\|$/, "").split("|").map(function (c) { return c.trim(); });
        }
        var headCells = splitRow(t);
        i += 2;
        var bodyRows = [];
        while (i < lines.length && lines[i].indexOf("|") !== -1 && lines[i].trim() !== "") {
          bodyRows.push(splitRow(lines[i].trim()));
          i++;
        }
        var th = headCells.map(function (c) { return "<th>" + inline(c) + "</th>"; }).join("");
        var tb = bodyRows.map(function (r) {
          return "<tr>" + r.map(function (c) { return "<td>" + inline(c) + "</td>"; }).join("") + "</tr>";
        }).join("");
        out.push("<table><thead><tr>" + th + "</tr></thead><tbody>" + tb + "</tbody></table>");
        continue;
      }

      /* 无序列表 */
      if (/^[-*+]\s+/.test(t)) {
        flush();
        var lis = [];
        while (i < lines.length && /^[-*+]\s+/.test(lines[i].trim())) {
          lis.push(lines[i].trim().replace(/^[-*+]\s+/, ""));
          i++;
        }
        out.push("<ul>" + lis.map(function (x) { return "<li>" + inline(x) + "</li>"; }).join("") + "</ul>");
        continue;
      }

      /* 有序列表 */
      if (/^\d+\.\s+/.test(t)) {
        flush();
        var olis = [];
        while (i < lines.length && /^\d+\.\s+/.test(lines[i].trim())) {
          olis.push(lines[i].trim().replace(/^\d+\.\s+/, ""));
          i++;
        }
        out.push("<ol>" + olis.map(function (x) { return "<li>" + inline(x) + "</li>"; }).join("") + "</ol>");
        continue;
      }

      /* 原样 HTML 行（锚点、占位容器等） */
      if (/^<\/?[a-zA-Z!]/.test(t)) {
        flush(); out.push(line); i++; continue;
      }

      para.push(line);
      i++;
    }
    flush();
    return out.join("\n");
  }

  /* ---------------------------------------------------------- */

  function parseHash() {
    var h = (location.hash || "").replace(/^#/, "");
    var parts = h.split("/");
    var doc = parts[0] || DEFAULT_DOC;
    if (!DOCS[doc]) doc = DEFAULT_DOC;
    return { doc: doc, anchor: parts[1] || "" };
  }

  function renderMarkdown(md) {
    if (window.marked && typeof marked.parse === "function") {
      try {
        return marked.parse(md, { gfm: true, breaks: false });
      } catch (e) { /* 交给降级解析器 */ }
    }
    return miniMarkdown(md);
  }

  /* 站内文档链接改写：features → #features，advanced#x → #advanced/x */
  function rewriteLinks(root) {
    root.querySelectorAll("a[href]").forEach(function (a) {
      var href = a.getAttribute("href") || "";
      if (/^(https?:|mailto:)/i.test(href)) {
        a.target = "_blank";
        a.rel = "noopener";
        return;
      }
      if (href.charAt(0) === "#" || href.charAt(0) === "/") return;
      var m = href.match(/^([a-zA-Z]+)(?:#(.+))?$/);
      if (m && DOCS[m[1].toLowerCase()]) {
        a.setAttribute("href", "#" + m[1].toLowerCase() + (m[2] ? "/" + m[2] : ""));
      }
    });
  }

  /* 本页目录 */
  function buildToc() {
    var heads = contentEl.querySelectorAll("h2, h3");
    if (!heads.length) {
      tocWrap.classList.add("is-empty");
      tocNavEl.innerHTML = "";
      return;
    }
    tocWrap.classList.remove("is-empty");
    tocNavEl.innerHTML = "";
    heads.forEach(function (h, idx) {
      if (!h.id) h.id = "sec-" + (idx + 1);
      var a = document.createElement("a");
      a.href = "#" + current.doc + "/" + h.id;
      a.textContent = h.textContent;
      if (h.tagName === "H3") a.className = "is-sub";
      tocNavEl.appendChild(a);
    });
  }

  tocNavHandlerInit();
  function tocNavHandlerInit() {
    document.addEventListener("click", function (e) {
      var a = e.target.closest ? e.target.closest("#wikiTocNav a") : null;
      if (!a) return;
      e.preventDefault();
      var id = (a.getAttribute("href") || "").split("/")[1] || "";
      var el = document.getElementById(id);
      if (!el) return;
      if (el.scrollIntoView) el.scrollIntoView({ behavior: "smooth", block: "start" });
      if (history.replaceState) history.replaceState(null, "", "#" + current.doc + "/" + id);
      current.anchor = id;
      updateSidebar();
      updateCrumb(id);
    });
  }

  /* 侧栏高亮 */
  function updateSidebar() {
    if (!sidebarEl) return;
    var target = current.doc + (current.anchor ? "/" + current.anchor : "");
    var matched = false;
    sidebarEl.querySelectorAll("a[href^='#']").forEach(function (a) {
      var hit = (a.getAttribute("href") || "").slice(1) === target;
      a.classList.toggle("active", hit);
      if (hit) matched = true;
    });
    if (!matched) {
      sidebarEl.querySelectorAll("a[data-doc]").forEach(function (a) {
        a.classList.toggle("active", a.getAttribute("data-doc") === current.doc);
      });
    }
  }

  /* 面包屑 */
  function updateCrumb(anchor) {
    if (!crumbEl) return;
    var meta = DOCS[current.doc];
    var html = '<a href="#index">Wiki</a> <span class="sep">/</span> <span class="now">' + meta.title + "</span>";
    if (anchor) {
      var el = document.getElementById(anchor);
      var node = el;
      var label = "";
      while (node && !/^H[1-6]$/.test(node.tagName)) { node = node.nextElementSibling; }
      if (node) label = node.textContent.trim();
      if (label) {
        html += ' <span class="sep">/</span> <span class="now">' + label + "</span>";
      }
    }
    crumbEl.innerHTML = html;
  }

  /* 自定义附魔数据表 */
  function renderEnchantTable() {
    var wrap = document.getElementById("enchantWiki");
    if (!wrap || wrap.dataset.loaded) return;
    wrap.dataset.loaded = "1";
    wrap.innerHTML = '<p class="wiki-loading">附魔数据加载中…</p>';

    fetch("data_enchants.json")
      .then(function (r) { return r.json(); })
      .then(function (data) {
        wrap.innerHTML =
          '<div class="enchant-container"><ul class="enchant-tabs"></ul>' +
          '<div class="enchant-content"></div></div>';
        var tabs = wrap.querySelector(".enchant-tabs");
        var content = wrap.querySelector(".enchant-content");

        function paint(idx) {
          var cat = data[idx];
          var html = '<table class="enchant-table"><thead><tr>' +
            cat.headers.map(function (x) { return "<th>" + x + "</th>"; }).join("") +
            "</tr></thead><tbody>";
          cat.rows.forEach(function (row) {
            html += "<tr>" + row.map(function (c) { return "<td>" + c + "</td>"; }).join("") + "</tr>";
          });
          content.innerHTML = html + "</tbody></table>";
          content.scrollTop = 0;
        }

        data.forEach(function (cat, idx) {
          var li = document.createElement("li");
          li.textContent = cat.category;
          if (idx === 0) li.classList.add("active");
          li.addEventListener("click", function () {
            tabs.querySelectorAll("li").forEach(function (el) { el.classList.remove("active"); });
            li.classList.add("active");
            paint(idx);
          });
          tabs.appendChild(li);
        });
        paint(0);
      })
      .catch(function () {
        wrap.innerHTML = "<p>附魔数据加载失败，请刷新重试。</p>";
      });
  }

  /* 渲染一篇文档 */
  function paint(md, anchor) {
    contentEl.innerHTML = renderMarkdown(md);
    rewriteLinks(contentEl);
    buildToc();
    renderEnchantTable();
    updateSidebar();
    updateCrumb(anchor);

    if (anchor) {
      var el = document.getElementById(anchor);
      if (el && el.scrollIntoView) {
        el.scrollIntoView({ block: "start" });
      } else {
        window.scrollTo(0, 0);
      }
    } else {
      window.scrollTo(0, 0);
    }
  }

  function load(route) {
    current = route;
    var meta = DOCS[route.doc];
    document.title = meta.title + " — STCraft Wiki";
    updateSidebar();

    if (cache[route.doc]) {
      try {
        paint(cache[route.doc], route.anchor);
      } catch (e) {
        if (window.console) console.error(e);
      }
      return;
    }

    contentEl.innerHTML = '<p class="wiki-loading">加载中…</p>';
    fetch(meta.file)
      .then(function (res) {
        if (!res.ok) throw new Error(res.status);
        return res.text();
      })
      .then(
        function (md) {
          cache[route.doc] = md;
          if (current.doc === route.doc) {
            try {
              paint(md, route.anchor);
            } catch (e) {
              if (window.console) console.error(e);
            }
          }
        },
        function () {
          contentEl.innerHTML =
            '<p class="wiki-loading">文档加载失败，请<a href="' +
            location.pathname + '">刷新</a>重试。</p>';
        }
      );
  }

  /* ---------------------------------------------------------- */

  document.addEventListener("DOMContentLoaded", function () {
    contentEl = $("wikiContent");
    tocWrap = $("wikiToc");
    tocNavEl = $("wikiTocNav");
    crumbEl = $("wikiCrumb");
    sidebarEl = $("wikiSidebar");
    if (!contentEl) return;

    window.addEventListener("hashchange", function () {
      var r = parseHash();
      if (r.doc === current.doc && r.anchor === current.anchor) return;
      load(r);
    });

    var sideToggle = $("wikiSideToggle");
    if (sideToggle && sidebarEl) {
      sideToggle.addEventListener("click", function () {
        sidebarEl.classList.toggle("open");
      });
      sidebarEl.querySelectorAll("a").forEach(function (a) {
        a.addEventListener("click", function () {
          sidebarEl.classList.remove("open");
        });
      });
    }

    load(parseHash());
  });
})();
