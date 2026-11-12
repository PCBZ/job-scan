import json

import httpx2 as httpx
from openai import AzureOpenAI

from scanner.extract import Extractor, extract_all
from scanner.telemetry import HTTP_CLIENTS, LOGGER, configure, span
from scanner.run import run_scan

from .helpers import CONFIG, DESCRIPTION, INDEED, ROWS, STARTED_AT, FakeContainer, FakeQueue, extractor, frame


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
    assert {"requests", "httpx2"} <= set(HTTP_CLIENTS)


def test_a_run_is_one_trace_its_stages_nest_under_it_and_the_file_names_it(spans):
    container, queue = FakeContainer(), FakeQueue()
    name = run_scan(
        config_text=lambda: CONFIG,
        scrape=lambda **_: frame(*ROWS),
        extractor=extractor,
        container=container,  # type: ignore[arg-type]
        queue=queue,  # type: ignore[arg-type]
        now=lambda: STARTED_AT,
    )
    by_name = {s.name: s for s in spans.get_finished_spans()}
    run = by_name["jobspy run"]
    assert run.parent is None
    for stage in ("node scrape", "node extract_postings"):
        assert by_name[stage].parent.span_id == run.context.span_id
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
            extractor=extractor,
            container=container,  # type: ignore[arg-type]
            queue=FakeQueue(),  # type: ignore[arg-type]
        )
    except ValueError:
        pass
    (run,) = [s for s in spans.get_finished_spans() if s.name == "jobspy run"]
    assert not run.status.is_ok
    assert json.loads(next(iter(container.blobs.values())))["trace"]["trace_id"] == f"{run.context.trace_id:032x}"


def _azure_openai(answer: dict) -> AzureOpenAI:
    """The real client, over a transport that answers as Azure would."""

    def respond(request: httpx.Request) -> httpx.Response:
        return httpx.Response(
            200,
            json={
                "id": "chatcmpl-1",
                "object": "chat.completion",
                "created": 0,
                "model": "extract-2026-03-17",
                "choices": [
                    {
                        "index": 0,
                        "finish_reason": "stop",
                        "message": {"role": "assistant", "content": json.dumps(answer)},
                    }
                ],
                "usage": {"prompt_tokens": 100, "completion_tokens": 20, "total_tokens": 120},
            },
        )

    return AzureOpenAI(
        azure_endpoint="https://example.openai.azure.com",
        api_key="fake",
        api_version="2024-10-21",
        http_client=httpx.Client(transport=httpx.MockTransport(respond)),
    )


def test_each_model_call_is_a_span_under_its_stage_with_no_posting_text(spans):
    answer = {"workplace": "remote", "salary": "", "requirements": ["Python"], "skills": ["Python"]}
    client = _azure_openai(answer)
    with span("node extract_postings") as stage:
        out = extract_all([INDEED, INDEED], Extractor(client, "extract"), concurrency=2, budget=5)
    assert out.failed == 0
    calls = [s for s in spans.get_finished_spans() if s.name != "node extract_postings"]
    assert len(calls) == 2
    assert all(c.parent.span_id == stage.get_span_context().span_id for c in calls)
    recorded = json.dumps([dict(c.attributes or {}) for c in calls], default=str)
    assert DESCRIPTION not in recorded and "Acme Pay" not in recorded
    assert "extract-2026-03-17" in recorded  # the model is kept


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


def test_an_answer_that_does_not_fit_is_no_result_and_its_text_stays_out_of_the_spans(spans):
    bad = {"workplace": "QUOTED-FROM-THE-POSTING", "salary": "", "requirements": [], "skills": []}
    result, usage = Extractor(_azure_openai(bad), "extract").extract(INDEED)
    assert result is None and usage.input == 100
    (call,) = spans.get_finished_spans()
    assert call.status.is_ok
    assert "QUOTED-FROM-THE-POSTING" not in _everything_exported(spans)


def test_a_failed_stage_records_the_error_type_only(spans):
    try:
        with span("node scrape"):
            raise ValueError("Acme Pay, Software Engineer in Boston")
    except ValueError:
        pass
    (stage,) = spans.get_finished_spans()
    assert stage.status.description == "ValueError"
    assert [dict(e.attributes or {}) for e in stage.events] == [{"exception.type": "ValueError"}]
    assert "Acme Pay" not in _everything_exported(spans)
