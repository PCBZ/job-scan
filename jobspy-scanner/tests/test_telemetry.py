import json

from scanner.telemetry import HTTP_CLIENTS, LOGGER, RUN_SPAN, configure, node_span, span
from scanner.run import run_scan

from .helpers import CONFIG, ROWS, STARTED_AT, FakeContainer, FakeQueue, frame


def test_the_span_names_are_the_ones_the_latency_query_reads():
    # functions/src/lib/telemetry/spans.ts can't be imported here; its test pins the same values.
    assert RUN_SPAN == "jobspy run"
    assert node_span("scrape") == "node scrape"


def test_nothing_is_configured_without_a_connection_string():
    calls = []
    assert configure({}, lambda **kw: calls.append(kw)) is False
    assert calls == []


def test_it_exports_only_its_own_logs_with_the_http_clients_off():
    calls = []
    assert configure({"APPLICATIONINSIGHTS_CONNECTION_STRING": "InstrumentationKey=x"}, lambda **kw: calls.append(kw))
    (options,) = calls
    assert options["logger_name"] == LOGGER
    assert options["instrumentation_options"] == {name: {"enabled": False} for name in HTTP_CLIENTS}
    assert "requests" in HTTP_CLIENTS


def test_a_run_is_one_trace_its_stages_nest_under_it_and_the_file_names_it(spans):
    container, queue = FakeContainer(), FakeQueue()
    name = run_scan(
        config_text=lambda: CONFIG,
        scrape=lambda **_: frame(*ROWS),
        container=container,  # type: ignore[arg-type]
        queue=queue,  # type: ignore[arg-type]
        now=lambda: STARTED_AT,
    )
    by_name = {s.name: s for s in spans.get_finished_spans()}
    run = by_name[RUN_SPAN]
    assert run.parent is None
    assert by_name[node_span("scrape")].parent.span_id == run.context.span_id
    # No model is called here any more (#204): collect reads the postings.
    assert set(by_name) == {RUN_SPAN, node_span("scrape")}
    handoff = json.loads(container.blobs[name])
    assert handoff["trace"] == {
        "trace_id": f"{run.context.trace_id:032x}",
        "span_id": f"{run.context.span_id:016x}",
    }


def test_a_failed_run_is_a_failed_span_and_still_names_its_trace(spans):
    container = FakeContainer()
    try:
        run_scan(
            config_text=lambda: "not toml [",
            scrape=lambda **_: frame(),
            container=container,  # type: ignore[arg-type]
            queue=FakeQueue(),  # type: ignore[arg-type]
        )
    except ValueError:
        pass
    (run,) = [s for s in spans.get_finished_spans() if s.name == RUN_SPAN]
    assert not run.status.is_ok
    assert json.loads(next(iter(container.blobs.values())))["trace"]["trace_id"] == f"{run.context.trace_id:032x}"


def _everything_exported(spans) -> str:
    """Every attribute, event and status a test's spans would export, as text."""
    return json.dumps(
        [
            {
                "attributes": dict(s.attributes or {}),
                "events": [dict(e.attributes or {}) for e in s.events],
                "status": s.status.description,
            }
            for s in spans.get_finished_spans()
        ],
        default=str,
    )


def test_a_failed_stage_records_the_error_type_only(spans):
    try:
        with span(node_span("scrape")):
            raise ValueError("Acme Pay, Software Engineer in Boston")
    except ValueError:
        pass
    (stage,) = spans.get_finished_spans()
    assert stage.status.description == "ValueError"
    assert [dict(e.attributes or {}) for e in stage.events] == [{"exception.type": "ValueError"}]
    assert "Acme Pay" not in _everything_exported(spans)
