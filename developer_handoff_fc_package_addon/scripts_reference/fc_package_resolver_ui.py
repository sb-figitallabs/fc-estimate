from __future__ import annotations

import argparse
import html
import json
from http import HTTPStatus
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from typing import Any
from urllib.parse import parse_qs, urlparse

from bill_audit.package_audit import (
    fetch_curated_tariff_package_catalog,
    resolve_curated_package_candidate_with_gemini,
)
from fc_estimate.assembly import build_fc_estimate_input_bundle


DEFAULT_HOST = "127.0.0.1"
DEFAULT_PORT = 8765
FALLBACK_TARIFFS = ["TR1", "TR201", "TR285", "TR287", "TR288", "TR289", "TR290"]


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(description="Local UI to test curated package resolution with Gemini and preview the FC handoff bundle.")
    parser.add_argument("--host", default=DEFAULT_HOST)
    parser.add_argument("--port", type=int, default=DEFAULT_PORT)
    return parser.parse_args()


def parse_form_body(body: bytes) -> dict[str, str]:
    raw = parse_qs(body.decode("utf-8"), keep_blank_values=True)
    return {key: values[0] if values else "" for key, values in raw.items()}


def pretty_json(data: Any) -> str:
    return json.dumps(data, indent=2, ensure_ascii=True)


def load_tariff_options() -> list[str]:
    options = [tariff for tariff in FALLBACK_TARIFFS if fetch_curated_tariff_package_catalog(tariff)]
    return options or FALLBACK_TARIFFS


def stat_card(label: str, value: Any) -> str:
    return f"""
    <article class="stat">
      <span class="label">{html.escape(label)}</span>
      <strong>{html.escape('-' if value is None or value == '' else str(value))}</strong>
    </article>
    """


def render_page(
    *,
    form: dict[str, str] | None = None,
    ai_resolution: dict[str, Any] | None = None,
    bundle: dict[str, Any] | None = None,
    error: str | None = None,
    tariff_options: list[str] | None = None,
) -> str:
    form = form or {}
    tariff_options = tariff_options or FALLBACK_TARIFFS
    runtime_resolution = (ai_resolution or {}).get("package_runtime_resolution") or {}
    runtime_row = runtime_resolution.get("package_runtime") or {}
    case_history = runtime_resolution.get("case_history") or {}
    selected_template = ((bundle or {}).get("template_selection") or {}).get("selected_template") or {}

    tariff_option_markup = "".join(
        f'<option value="{html.escape(code, quote=True)}"{" selected" if form.get("tariff_code", "") == code else ""}>{html.escape(code)}</option>'
        for code in tariff_options
    )

    error_block = f'<section class="card error"><strong>Error:</strong> {html.escape(error)}</section>' if error else ""

    summary = ""
    if ai_resolution:
        summary = f"""
        <section class="grid">
          {stat_card("Tariff Code", ai_resolution.get("tariff_code"))}
          {stat_card("AI Match Status", ai_resolution.get("status"))}
          {stat_card("Package Code", runtime_resolution.get("resolved_package_code"))}
          {stat_card("Package Name", runtime_resolution.get("resolved_package_name"))}
          {stat_card("Runtime Status", runtime_row.get("runtime_status"))}
          {stat_card("FC Package Code", runtime_row.get("fc_template_package_code"))}
          {stat_card("FC Package Name", runtime_row.get("fc_template_primary_package_name"))}
          {stat_card("FC Case Count", runtime_row.get("fc_case_count_total"))}
          {stat_card("Observed Admissions", case_history.get("admission_count"))}
        </section>
        """

    result_block = ""
    if ai_resolution:
        if ai_resolution.get("status") == "no_package_exists":
            result_block = f"""
            <section class="card">
              <h3>No Package Exists</h3>
              <p class="muted">{html.escape(str(ai_resolution.get("reason") or "No curated package exists for this treatment under the selected tariff code."))}</p>
              <section class="stack">
                <div>
                  <h4>Gemini Resolution</h4>
                  <pre>{html.escape(pretty_json(ai_resolution.get("gemini_result") or {}))}</pre>
                </div>
                <div>
                  <h4>Tariff Catalog Sample</h4>
                  <pre>{html.escape(pretty_json(ai_resolution.get("catalog_candidates") or []))}</pre>
                </div>
              </section>
            </section>
            """
        elif ai_resolution.get("status") == "matched":
            result_block = f"""
            <section class="card">
              <h3>Gemini Resolution</h3>
              <pre>{html.escape(pretty_json(ai_resolution.get("gemini_result") or {}))}</pre>
            </section>
            <section class="card">
              <h3>Curated Package Runtime</h3>
              <pre>{html.escape(pretty_json(runtime_row or {}))}</pre>
            </section>
            <section class="card">
              <h3>FC Package History</h3>
              <div class="table-wrap">
                <table>
                  <tbody>
                    <tr><th>Admission Count</th><td>{html.escape(str(case_history.get("admission_count") or 0))}</td></tr>
                    <tr><th>Latest Admission</th><td>{html.escape(str(case_history.get("latest_admission_at") or "-"))}</td></tr>
                    <tr><th>Observed Amount Range</th><td>{html.escape(str(case_history.get("min_observed_package_amount") or "-"))} to {html.escape(str(case_history.get("max_observed_package_amount") or "-"))}</td></tr>
                  </tbody>
                </table>
              </div>
              <pre>{html.escape(pretty_json(case_history or {}))}</pre>
            </section>
            <section class="card">
              <h3>FC Handoff Bundle Preview</h3>
              <p class="muted">This is the exact bundle preview that would be handed to the FC estimate builder. The builder is not executed here.</p>
              <pre>{html.escape(pretty_json(bundle or {}))}</pre>
            </section>
            <section class="card">
              <h3>Selected Template Snapshot</h3>
              <pre>{html.escape(pretty_json(selected_template or {}))}</pre>
            </section>
            """
        else:
            result_block = f"""
            <section class="card">
              <h3>Resolution Result</h3>
              <pre>{html.escape(pretty_json(ai_resolution or {}))}</pre>
            </section>
            """

    return f"""<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>Curated Package Resolver Tester</title>
  <style>
    :root {{
      --bg: #f6f1e8;
      --paper: #fffdf9;
      --ink: #1f2a2f;
      --muted: #66757f;
      --line: #d7c7b5;
      --accent: #0f766e;
      --warn-soft: #fde7e7;
      --shadow: 0 10px 30px rgba(40, 32, 23, 0.08);
    }}
    * {{ box-sizing: border-box; }}
    body {{
      margin: 0;
      font-family: ui-sans-serif, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
      color: var(--ink);
      background:
        radial-gradient(circle at top left, #f2dcc5 0, transparent 32%),
        linear-gradient(180deg, #f8f4ec 0, #f2ede3 100%);
    }}
    .shell {{ max-width: 1200px; margin: 0 auto; padding: 28px; }}
    .hero {{ margin-bottom: 18px; }}
    h1 {{ margin: 0 0 8px; font-size: 32px; }}
    .muted {{ color: var(--muted); }}
    .layout {{ display: grid; grid-template-columns: 360px minmax(0, 1fr); gap: 20px; align-items: start; }}
    .card {{
      background: var(--paper);
      border: 1px solid rgba(103, 86, 66, 0.14);
      border-radius: 18px;
      box-shadow: var(--shadow);
      padding: 18px;
      margin-bottom: 18px;
    }}
    .error {{ background: var(--warn-soft); border-color: #efb7b7; }}
    .grid {{ display: grid; grid-template-columns: repeat(3, minmax(0, 1fr)); gap: 14px; margin-bottom: 18px; }}
    .stat {{
      background: var(--paper);
      border: 1px solid rgba(103, 86, 66, 0.14);
      border-radius: 18px;
      box-shadow: var(--shadow);
      padding: 18px;
    }}
    .label {{ display: block; font-size: 12px; color: var(--muted); text-transform: uppercase; letter-spacing: 0.06em; margin-bottom: 8px; }}
    form label {{ display: block; font-weight: 600; font-size: 13px; margin-bottom: 6px; }}
    input, select, textarea {{
      width: 100%;
      padding: 10px 12px;
      border-radius: 12px;
      border: 1px solid var(--line);
      background: #fff;
      color: var(--ink);
      font: inherit;
    }}
    textarea {{ min-height: 180px; resize: vertical; }}
    .field {{ margin-bottom: 14px; }}
    .actions {{ display: flex; gap: 10px; margin-top: 14px; }}
    button {{
      border: 0;
      border-radius: 999px;
      padding: 11px 16px;
      background: var(--accent);
      color: #fff;
      font-weight: 700;
      cursor: pointer;
    }}
    button.secondary {{
      background: #e8ddd0;
      color: var(--ink);
    }}
    pre {{
      margin: 0;
      padding: 14px;
      overflow: auto;
      border-radius: 14px;
      background: #faf6ef;
      border: 1px solid rgba(103, 86, 66, 0.12);
      font-size: 12px;
      line-height: 1.45;
    }}
    .table-wrap {{ overflow: auto; }}
    table {{ width: 100%; border-collapse: collapse; font-size: 13px; }}
    th, td {{ text-align: left; padding: 10px 8px; border-bottom: 1px solid #eee3d6; vertical-align: top; }}
    th {{ font-size: 12px; color: var(--muted); text-transform: uppercase; letter-spacing: 0.04em; width: 220px; }}
    .note {{
      font-size: 12px;
      color: var(--muted);
      background: #f3ede4;
      border-radius: 12px;
      padding: 12px;
      margin-top: 12px;
    }}
    @media (max-width: 1000px) {{
      .layout {{ grid-template-columns: 1fr; }}
      .grid {{ grid-template-columns: 1fr 1fr; }}
    }}
    @media (max-width: 720px) {{
      .shell {{ padding: 18px; }}
      .grid {{ grid-template-columns: 1fr; }}
    }}
  </style>
</head>
<body>
  <div class="shell">
    <header class="hero">
      <h1>Curated Package Resolver Tester</h1>
      <p class="muted">This UI uses only the new curated package dataset. Enter a tariff code and raw treatment text, Gemini will normalize the treatment to an exact curated package candidate, and the app will either show the package details plus FC mapping/history or say no package exists.</p>
    </header>
    <div class="layout">
      <aside>
        <section class="card">
          <h3>Lookup Inputs</h3>
          <form method="post" action="/">
            <div class="field">
              <label for="tariff_code">Tariff Code</label>
              <select id="tariff_code" name="tariff_code">{tariff_option_markup}</select>
            </div>
            <div class="field">
              <label for="raw_treatment_text">Raw Treatment Text</label>
              <textarea id="raw_treatment_text" name="raw_treatment_text" placeholder="e.g. Coronary angiogram / CAG or robotic unilateral TKR right planned">{html.escape(form.get("raw_treatment_text", ""))}</textarea>
            </div>
            <div class="actions">
              <button type="submit">Find Package</button>
              <button type="button" class="secondary" id="reset-form">Reset</button>
            </div>
            <div class="note">
              Gemini must be available via <code>GEMINI_API_KEY</code>. The lookup is curated-only: if Gemini cannot map the treatment to a package that exists under the selected tariff, the result will be <strong>No Package Exists</strong>.
            </div>
          </form>
        </section>
      </aside>
      <main>
        {error_block}
        {summary}
        {result_block or '<section class="card"><h3>Ready to test</h3><p class="muted">Choose a tariff code, paste the raw treatment text, and click <strong>Find Package</strong>.</p></section>'}
      </main>
    </div>
  </div>
  <script>
    const reset = document.getElementById('reset-form');
    if (reset) {{
      reset.addEventListener('click', () => window.location.href = '/');
    }}
  </script>
</body>
</html>"""


class ResolverUIHandler(BaseHTTPRequestHandler):
    tariff_options = load_tariff_options()

    def do_GET(self) -> None:  # noqa: N802
        parsed = urlparse(self.path)
        if parsed.path == "/health":
            self._write_text(HTTPStatus.OK, "ok", "text/plain; charset=utf-8")
            return
        self._write_html(HTTPStatus.OK, render_page(tariff_options=self.tariff_options))

    def do_POST(self) -> None:  # noqa: N802
        if self.path != "/":
            self.send_error(HTTPStatus.NOT_FOUND)
            return
        try:
            content_length = int(self.headers.get("Content-Length", "0"))
        except ValueError:
            content_length = 0
        form = parse_form_body(self.rfile.read(content_length))
        try:
            ai_resolution = resolve_curated_package_candidate_with_gemini(
                tariff_code=(form.get("tariff_code") or "").strip() or None,
                raw_treatment_text=(form.get("raw_treatment_text") or "").strip() or None,
            )
            bundle = None
            if ai_resolution.get("status") == "matched":
                runtime_resolution = ai_resolution.get("package_runtime_resolution") or {}
                runtime_row = runtime_resolution.get("package_runtime") or {}
                bundle = build_fc_estimate_input_bundle(
                    hospital_id=1,
                    soap_text=(form.get("raw_treatment_text") or "").strip() or None,
                    payor_bucket=runtime_row.get("payor_bucket"),
                    tariff_code=ai_resolution.get("tariff_code"),
                    department_name=runtime_row.get("department_name"),
                    package_code=runtime_resolution.get("resolved_package_code"),
                    package_name=runtime_resolution.get("resolved_package_name"),
                    curated_only_package_lookup=True,
                )
            self._write_html(
                HTTPStatus.OK,
                render_page(
                    form=form,
                    ai_resolution=ai_resolution,
                    bundle=bundle,
                    tariff_options=self.tariff_options,
                ),
            )
        except Exception as exc:  # noqa: BLE001
            self._write_html(
                HTTPStatus.OK,
                render_page(
                    form=form,
                    error=str(exc),
                    tariff_options=self.tariff_options,
                ),
            )

    def log_message(self, format: str, *args: Any) -> None:  # noqa: A003
        return

    def _write_html(self, status: HTTPStatus, content: str) -> None:
        self._write_text(status, content, "text/html; charset=utf-8")

    def _write_text(self, status: HTTPStatus, content: str, content_type: str) -> None:
        encoded = content.encode("utf-8")
        self.send_response(status)
        self.send_header("Content-Type", content_type)
        self.send_header("Content-Length", str(len(encoded)))
        self.end_headers()
        self.wfile.write(encoded)


def main() -> None:
    args = parse_args()
    server = ThreadingHTTPServer((args.host, args.port), ResolverUIHandler)
    print(f"Curated Package Resolver Tester running at http://{args.host}:{args.port}")
    try:
        server.serve_forever()
    except KeyboardInterrupt:
        pass
    finally:
        server.server_close()


if __name__ == "__main__":
    main()
