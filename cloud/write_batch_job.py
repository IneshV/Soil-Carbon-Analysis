#!/usr/bin/env python3
"""Write a Cloud Batch job spec for the uncertainty-map array worker."""

from __future__ import annotations

import argparse
import json
from pathlib import Path


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--output", type=Path, required=True)
    parser.add_argument("--image", required=True)
    parser.add_argument("--service-account", required=True)
    parser.add_argument("--manifest-uri", required=True)
    parser.add_argument("--output-prefix", required=True)
    parser.add_argument("--task-count", type=int, required=True)
    parser.add_argument("--parallelism", type=int, required=True)
    parser.add_argument("--machine-type", default="e2-highmem-4")
    parser.add_argument("--project-id", required=True)
    parser.add_argument("--region", required=True)
    parser.add_argument("--network", default="default")
    parser.add_argument("--subnetwork", default="default")
    args = parser.parse_args()
    if args.task_count < 1 or not 1 <= args.parallelism <= args.task_count:
        parser.error("Require task-count >= 1 and 1 <= parallelism <= task-count")

    spec = {
        "taskGroups": [{
            "taskCount": args.task_count,
            "parallelism": args.parallelism,
            "taskSpec": {
                "runnables": [{"container": {
                    "imageUri": args.image,
                    "commands": [
                        "--manifest-uri", args.manifest_uri,
                        "--output-prefix", args.output_prefix,
                        "--depths", "5", "15", "30", "60", "100",
                    ],
                }}],
                "computeResource": {"cpuMilli": 4000, "memoryMib": 24576},
                "maxRetryCount": 2,
                "maxRunDuration": "21600s",
            },
        }],
        "allocationPolicy": {
            "instances": [{"policy": {"machineType": args.machine_type, "provisioningModel": "STANDARD"}}],
            "serviceAccount": {"email": args.service_account},
            "network": {"networkInterfaces": [{
                "network": f"projects/{args.project_id}/global/networks/{args.network}",
                "subnetwork": (
                    f"projects/{args.project_id}/regions/{args.region}/subnetworks/{args.subnetwork}"
                ),
                "noExternalIpAddress": True,
            }]},
        },
        "logsPolicy": {"destination": "CLOUD_LOGGING"},
    }
    args.output.write_text(json.dumps(spec, indent=2) + "\n")


if __name__ == "__main__":
    main()
