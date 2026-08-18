"""SWE-bench Pro task loader, container setup, and evaluator.

The official harness lives at https://github.com/scaleapi/SWE-bench_Pro-os.
Each instance ships a `run_script.sh` and a `parser.py` under
`run_scripts/<instance_id>/`. We reuse those verbatim — copying them into
the container, executing them, and consuming the JSON output.

Image URI convention: `jefzda/sweap-images:<dockerhub_tag>` where
`<dockerhub_tag>` is the field stored on each row.
"""
from __future__ import annotations

import ast
import json
import logging
import os
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any

from second_thought.docker_env import DockerContainer
from second_thought.orchestrator import Task
from second_thought.tool_runner import ToolResult

# mini-swe-agent imports are lazy (inside build_mini_run) so this module
# stays importable without mini-swe-agent installed. The legacy toy-task
# path doesn't need it.

logger = logging.getLogger(__name__)

DOCKERHUB_USER = "jefzda"
REGISTRY_REPO = "sweap-images"


def image_uri(dockerhub_tag: str) -> str:
    return f"{DOCKERHUB_USER}/{REGISTRY_REPO}:{dockerhub_tag}"


def _derive_dockerhub_tag(instance_id: str, repo: str) -> str:
    """Derive the jefzda DockerHub tag from instance_id + repo name.

    Mirrors the official helper at
    SWE-bench_Pro-os/helper_code/image_uri.py so that the new
    `sweap_eval_full_v2.jsonl` schema (which omits a per-row
    `dockerhub_tag` field) can resolve to the same images.
    """
    repo_base, repo_name_only = repo.lower().split("/")
    hsh = instance_id.replace("instance_", "")
    # Special-case from the official helper.
    if instance_id == "instance_element-hq__element-web-ec0f940ef0e8e3b61078f145f34dc40d1938e6c5-vnan":
        repo_name_only = "element-web"
    elif "element-hq" in repo.lower() and "element-web" in repo.lower():
        repo_name_only = "element"
        if hsh.endswith("-vnan"):
            hsh = hsh[:-5]
    elif hsh.endswith("-vnan"):
        hsh = hsh[:-5]
    tag = f"{repo_base}.{repo_name_only}-{hsh}"
    if len(tag) > 128:
        tag = tag[:128]
    return tag


def _coerce_list(value: Any) -> list[str]:
    """Some dataset fields are JSON strings; some are real lists."""
    if isinstance(value, list):
        return value
    if not value:
        return []
    if isinstance(value, str):
        try:
            return json.loads(value)
        except json.JSONDecodeError:
            try:
                return ast.literal_eval(value)
            except (SyntaxError, ValueError):
                return [value]
    return []


@dataclass
class SWEBenchProMeta:
    instance_id: str
    repo: str
    base_commit: str
    problem_statement: str
    requirements: str
    interface: str
    fail_to_pass: list[str]
    pass_to_pass: list[str]
    selected_test_files: list[str]
    before_repo_set_cmd: str
    dockerhub_tag: str
    test_patch: str
    repo_language: str = ""

    @property
    def image(self) -> str:
        return image_uri(self.dockerhub_tag)

    @classmethod
    def from_row(cls, row: dict) -> "SWEBenchProMeta":
        # The dataset ships in two schemas:
        # - Old: `dockerhub_tag`, lowercase `fail_to_pass`/`pass_to_pass`,
        #   `requirements`, `interface`, `repo_language` present.
        # - New (sweap_eval_full_v2.jsonl): uppercase `FAIL_TO_PASS`/
        #   `PASS_TO_PASS`, no `dockerhub_tag` (derived from instance_id),
        #   no `requirements`/`interface`/`repo_language`.
        instance_id = row["instance_id"]
        repo = row["repo"]
        dockerhub_tag = row.get("dockerhub_tag") or _derive_dockerhub_tag(instance_id, repo)
        f2p = row.get("fail_to_pass")
        if f2p is None:
            f2p = row.get("FAIL_TO_PASS")
        p2p = row.get("pass_to_pass")
        if p2p is None:
            p2p = row.get("PASS_TO_PASS")
        return cls(
            instance_id=instance_id,
            repo=repo,
            base_commit=row["base_commit"],
            problem_statement=row["problem_statement"],
            requirements=row.get("requirements") or "",
            interface=row.get("interface") or "",
            fail_to_pass=_coerce_list(f2p),
            pass_to_pass=_coerce_list(p2p),
            selected_test_files=_coerce_list(row.get("selected_test_files_to_run")),
            before_repo_set_cmd=row.get("before_repo_set_cmd") or "",
            dockerhub_tag=dockerhub_tag,
            test_patch=row.get("test_patch") or "",
            repo_language=row.get("repo_language") or "",
        )


def load_subset(jsonl_path: str | Path) -> list[SWEBenchProMeta]:
    p = Path(jsonl_path)
    if not p.exists():
        raise FileNotFoundError(f"SWE-bench Pro subset not found at {p}")
    metas: list[SWEBenchProMeta] = []
    with p.open() as f:
        for line in f:
            line = line.strip()
            if not line:
                continue
            metas.append(SWEBenchProMeta.from_row(json.loads(line)))
    return metas


# Backwards-compat name (older code referenced this).
def load_swe_bench_pro_subset(jsonl_path: str | Path | None = None) -> list[Task]:
    if jsonl_path is None:
        jsonl_path = "benchmarks/data/swe_bench_pro_subset.jsonl"
    metas = load_subset(jsonl_path)
    return [meta_to_task(m) for m in metas]


def make_problem_prompt(meta: SWEBenchProMeta) -> str:
    parts = [meta.problem_statement.strip()]
    if meta.requirements:
        parts.append("\n\nRequirements:\n" + meta.requirements.strip())
    if meta.interface:
        parts.append("\n\nInterface:\n" + meta.interface.strip())
    parts.append(
        "\n\nThe repository is at /app and is already checked out at the "
        "base commit. You may inspect, edit, and run tests freely. When you "
        "are confident the fix is in place, submit with the sentinel "
        "`MINI_SWE_AGENT_FINAL_OUTPUT`."
    )
    return "".join(parts)


def setup_container(meta: SWEBenchProMeta) -> DockerContainer:
    """Pull the image (if needed), start the container, apply the test patch."""
    cont = DockerContainer(image=meta.image, cwd="/app", keep_alive="6h")
    cont.start()
    # Apply `before_repo_set_cmd`: this resets the repo to base_commit and
    # checks out the new test files (the test patch). The image's /app
    # already contains the repo, so a missing /app is a hard error.
    sanity = cont.exec_sync("test -d /app && echo OK || echo MISSING", timeout=15)
    if "OK" not in sanity.stdout:
        cont.stop()
        raise RuntimeError(
            f"/app not found in image {meta.image} (got: {sanity.stdout!r} {sanity.stderr!r})"
        )
    if meta.before_repo_set_cmd:
        r = cont.exec_sync(meta.before_repo_set_cmd, timeout=120)
        if r.returncode != 0:
            logger.warning(
                "before_repo_set_cmd failed for %s rc=%d stderr=%s",
                meta.instance_id, r.returncode, r.stderr[:500],
            )
    return cont


# Markers that identify a grading failure as OUR infrastructure dying rather
# than the model failing the task. Added 2026-07-28: the Docker daemon
# reclaimed containers mid-run and the resulting ungraded tasks were being
# counted as model failures, which biased whichever arm happened to be
# running when the daemon misbehaved (measured: SWE-Pro/qwen Base lost 12
# tasks and S1-extend 9, while Reflect lost 0).
_INFRA_FAILURE_MARKERS = (
    "No such container",
    "Cannot connect to the Docker daemon",
    "container not started",
    "docker cp failed",
    "Error response from daemon",
    "is not running",
)


def is_infra_failure(text: object) -> bool:
    """True when a grade failure is the harness's fault, not the model's."""
    s = str(text or "")
    return any(m in s for m in _INFRA_FAILURE_MARKERS)


def capture_patch(cont: DockerContainer, cwd: str = "/app",
                  max_untracked_bytes: int = 5_000_000) -> dict:
    """Snapshot the agent's edits so a lost container is not lost data.

    Added 2026-07-28. Previously the only record of what the agent did was
    the container itself; when the daemon reclaimed it the task became
    permanently ungradeable (no offline re-grade possible). This is
    strictly read-only -- ``git diff HEAD`` touches neither the index nor
    the worktree, so it cannot perturb the grade that runs next.

    Returns {diff, untracked, untracked_tar_b64, complete, error}, where
    ``complete`` means the snapshot alone reproduces the agent's final
    state (tracked diff + every untracked file captured).
    """
    out: dict = {"diff": "", "untracked": [], "untracked_tar_b64": "",
                 "complete": False, "error": None}
    try:
        d = cont.exec_sync(f"git -C {cwd} diff HEAD", timeout=120)
        out["diff"] = d.stdout
        if d.returncode != 0:
            out["error"] = (d.stderr or "")[:500]
            return out
        u = cont.exec_sync(
            f"git -C {cwd} ls-files --others --exclude-standard", timeout=60)
        untracked = [ln for ln in u.stdout.splitlines() if ln.strip()]
        out["untracked"] = untracked[:500]
        if not untracked:
            out["complete"] = True
            return out
        sz = cont.exec_sync(
            f"cd {cwd} && git ls-files -o --exclude-standard -z "
            f"| xargs -0 -r du -cb 2>/dev/null | tail -1 | cut -f1", timeout=60)
        try:
            total = int((sz.stdout or "0").strip() or 0)
        except ValueError:
            total = max_untracked_bytes + 1
        if total > max_untracked_bytes:
            out["error"] = f"untracked files too large to embed ({total} B)"
            return out
        tar = cont.exec_sync(
            f"cd {cwd} && git ls-files -o --exclude-standard -z "
            f"| tar -czf - --null -T - | base64 -w0", timeout=120)
        if tar.returncode == 0 and tar.stdout.strip():
            out["untracked_tar_b64"] = tar.stdout.strip()
            out["complete"] = True
        else:
            out["error"] = (tar.stderr or "tar failed")[:500]
    except Exception as e:  # container already gone, etc.
        out["error"] = f"{type(e).__name__}: {e}"
    return out


def grade_in_container(
    cont: DockerContainer,
    meta: SWEBenchProMeta,
    run_scripts_dir: str | Path,
    test_timeout: float = 1500.0,
) -> dict:
    """Copy in run_script.sh + parser.py and execute them inside the
    already-running container. Returns a structured result dict.
    """
    run_dir = Path(run_scripts_dir) / meta.instance_id
    if not run_dir.exists():
        return {"graded": False, "reason": f"run scripts not found at {run_dir}"}
    # Stage scripts into the container
    cont.copy_in(str(run_dir / "run_script.sh"), "/tmp/run_script.sh")
    cont.copy_in(str(run_dir / "parser.py"), "/tmp/parser.py")
    cont.exec_sync("chmod +x /tmp/run_script.sh", timeout=10)

    # Run tests with the agent's edits + the test patch already applied.
    test_args = ",".join(meta.selected_test_files)
    run_cmd = (
        f"/tmp/run_script.sh '{test_args}' "
        f"> /tmp/sb_stdout.log 2> /tmp/sb_stderr.log; "
        f"echo \"sb_runscript_exit=$?\" >> /tmp/sb_stdout.log"
    )
    rs = cont.exec_sync(run_cmd, timeout=test_timeout)
    if rs.timed_out:
        return {"graded": False, "reason": "test runner timed out", "stderr": rs.stderr[:1000]}

    # Run parser
    parse = cont.exec_sync(
        "python3 /tmp/parser.py /tmp/sb_stdout.log /tmp/sb_stderr.log /tmp/sb_results.json",
        timeout=60,
    )
    if parse.returncode != 0:
        # Parser sometimes writes to a default path even on failure
        cat = cont.exec_sync("cat /tmp/sb_results.json 2>/dev/null", timeout=5)
        if not cat.stdout.strip():
            return {
                "graded": False,
                "reason": "parser failed",
                "parser_stderr": parse.stderr[:1000],
            }
    cat = cont.exec_sync("cat /tmp/sb_results.json", timeout=10)
    try:
        results = json.loads(cat.stdout)
    except json.JSONDecodeError as e:
        return {"graded": False, "reason": f"parser produced unparseable json: {e}", "raw": cat.stdout[:500]}

    test_status = {t.get("name", ""): t.get("status", "") for t in results.get("tests", [])}
    f2p = [(t, test_status.get(t, "MISSING")) for t in meta.fail_to_pass]
    p2p = [(t, test_status.get(t, "MISSING")) for t in meta.pass_to_pass]
    n_f2p_pass = sum(1 for _, s in f2p if s == "PASSED")
    n_p2p_pass = sum(1 for _, s in p2p if s == "PASSED")
    overall = (n_f2p_pass == len(f2p)) and (n_p2p_pass == len(p2p))
    return {
        "graded": True,
        "passed": overall,
        "fail_to_pass_passed": n_f2p_pass,
        "fail_to_pass_total": len(f2p),
        "pass_to_pass_passed": n_p2p_pass,
        "pass_to_pass_total": len(p2p),
        "fail_to_pass_detail": f2p,
        "pass_to_pass_detail": p2p,
    }


def meta_to_task(
    meta: SWEBenchProMeta,
    run_scripts_dir: str | Path | None = None,
    grade_test_timeout: float = 1500.0,
) -> Task:
    """Build an orchestrator Task that:
    - executes bash actions inside the SWE-bench Pro container
    - on teardown, grades and stops the container
    """
    container_holder: dict = {"cont": None, "grade": None}

    def _ensure_container() -> DockerContainer:
        if container_holder["cont"] is None:
            container_holder["cont"] = setup_container(meta)
        return container_holder["cont"]

    async def tool_runner(command, cwd, timeout_sec, done_event=None):
        cont = _ensure_container()
        return await cont.exec_async(
            command=command, cwd=cwd, timeout_sec=timeout_sec, done_event=done_event,
        )

    async def success_check() -> bool:
        cont = container_holder["cont"]
        if cont is None or run_scripts_dir is None:
            return False
        try:
            res = grade_in_container(cont, meta, run_scripts_dir, test_timeout=grade_test_timeout)
        except Exception as e:
            container_holder["grade"] = {"graded": False, "reason": f"grader exception: {e}"}
            return False
        container_holder["grade"] = res
        return bool(res.get("passed"))

    def teardown():
        cont = container_holder["cont"]
        if cont is not None:
            cont.stop()
        container_holder["cont"] = None

    task = Task(
        task_id=meta.instance_id,
        problem_statement=make_problem_prompt(meta),
        repo_root="/app",
        success_check=success_check,
        tool_runner=tool_runner,
        teardown=teardown,
        meta={
            "instance_id": meta.instance_id,
            "repo": meta.repo,
            "image": meta.image,
            "base_commit": meta.base_commit,
            "language": meta.repo_language,
            "n_fail_to_pass": len(meta.fail_to_pass),
            "n_pass_to_pass": len(meta.pass_to_pass),
        },
    )
    # Stash the container holder so a runner can read the grade after.
    task.meta["_container_holder"] = container_holder
    # Eager-start the container so docker pull errors surface immediately
    # (rather than mid-stream).
    _ensure_container()
    return task


def get_grade(task: Task) -> dict | None:
    """After a task has run, fetch the grader's structured result."""
    holder = task.meta.get("_container_holder")
    if not holder:
        return None
    return holder.get("grade")


# ---------------------------------------------------------------------------
# Mini-swe-agent integration: build env+model+agent for one task and grade it
# afterwards using the same container.
# ---------------------------------------------------------------------------


def _load_default_agent_config() -> dict:
    """Load mini-swe-agent's default.yaml so we inherit its tuned templates."""
    import yaml
    from minisweagent.config import get_config_path

    path = get_config_path("default")
    with path.open() as f:
        return yaml.safe_load(f) or {}


def make_problem_prompt_for_mini(meta: SWEBenchProMeta) -> str:
    """The mini-swe-agent instance_template references {{task}} via Jinja.
    Pass the full problem statement (+ requirements / interface fields)."""
    parts = [meta.problem_statement.strip()]
    if meta.requirements:
        parts.append("\n\n## Requirements\n" + meta.requirements.strip())
    if meta.interface:
        parts.append("\n\n## Interface specifications\n" + meta.interface.strip())
    return "".join(parts)


def build_mini_run(
    meta: SWEBenchProMeta,
    *,
    mode: str,
    model_name: str,
    max_completion_tokens: int = 4096,
    step_limit: int = 30,
    cost_limit: float = 0.0,
    container_timeout_sec: int = 300,
    enable_reasoning: bool = True,
    reflect_atoms: list[str] | None = None,
):
    """Set up env + model + agent for one SWE-bench Pro task.

    Returns (agent, env, model, task_prompt, grade_fn, teardown_fn).
    The container is already started and `before_repo_set_cmd` applied.
    """
    # Lazy import — keeps the module importable in environments where
    # mini-swe-agent isn't installed (e.g. our local toy-task test runs).
    from second_thought.mini_runner import SecondThoughtModel, MiniDockerEnvironment, ReflectAgent

    env = MiniDockerEnvironment(
        image=meta.image,
        cwd="/app",
        timeout=container_timeout_sec,
    )
    sanity = env.execute("test -d /app && echo OK || echo MISSING")
    if "OK" not in sanity.get("output", ""):
        env.stop()
        raise RuntimeError(f"/app missing in image {meta.image}")
    if meta.before_repo_set_cmd:
        r = env.execute(meta.before_repo_set_cmd, timeout=120)
        if r.get("returncode") != 0:
            logger.warning(
                "before_repo_set_cmd rc=%d for %s: %s",
                r.get("returncode"), meta.instance_id, (r.get("output") or "")[:500],
            )

    model = SecondThoughtModel(
        model_name=model_name,
        max_tokens=max_completion_tokens,
        enable_reasoning=enable_reasoning,
    )

    cfg_yaml = _load_default_agent_config()
    agent_cfg = dict(cfg_yaml.get("agent") or {})
    # mini-swe-agent's default has step_limit/cost_limit at 0; we override
    # so runs that go off the rails terminate cleanly.
    agent_cfg["step_limit"] = step_limit
    agent_cfg["cost_limit"] = cost_limit
    agent_cfg["mode"] = mode
    if reflect_atoms is not None:
        agent_cfg["reflect_atoms"] = reflect_atoms

    agent = ReflectAgent(model, env, **agent_cfg)
    task_prompt = make_problem_prompt_for_mini(meta)

    def grade_fn() -> dict:
        return grade_in_container(
            env.container, meta,
            # Point at your SWE-bench_Pro-os checkout's run_scripts/ dir.
            run_scripts_dir=os.environ.get("SWEBENCH_PRO_RUN_SCRIPTS_DIR", "run_scripts"),
            test_timeout=1500.0,
        )

    def teardown_fn() -> None:
        env.stop()

    return agent, env, model, task_prompt, grade_fn, teardown_fn
