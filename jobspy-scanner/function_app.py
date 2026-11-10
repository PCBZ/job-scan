"""The scan's timer, and the Azure clients it runs on."""

import logging
import os

import azure.functions as func
from azure.identity import DefaultAzureCredential
from azure.storage.blob import BlobClient, ContainerClient
from azure.storage.queue import QueueClient

from scanner.run import run_scan

app = func.FunctionApp()


def _setting(name: str) -> str:
    value = os.environ.get(name, "")
    if not value:
        raise RuntimeError(f"missing app setting: {name}")
    return value


# Same time as the mail source's run (15:00 UTC), so the two scrape side by side.
@app.timer_trigger(schedule="0 0 15 * * *", arg_name="timer", use_monitor=False)
def scan(timer: func.TimerRequest) -> None:
    from jobspy import scrape_jobs

    credential = DefaultAzureCredential()
    config = BlobClient.from_blob_url(_setting("CONFIG_BLOB_URL"), credential=credential)
    blob = run_scan(
        config_text=lambda: config.download_blob().readall().decode("utf-8"),
        scrape=scrape_jobs,
        container=ContainerClient.from_container_url(_setting("POSTINGS_URL"), credential=credential),
        queue=QueueClient.from_queue_url(_setting("POSTINGS_QUEUE_URL"), credential=credential),
    )
    logging.info("jobspy scan: %s", blob or "off")
