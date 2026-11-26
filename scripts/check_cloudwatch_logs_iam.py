"""Read-only check for the CloudWatch Logs IAM change enforced 2027-04-26.

From that date, CloudWatch Logs log-group actions (CreateLogGroup,
DescribeLogStreams, PutRetentionPolicy, ...) are granted only by a log group
ARN (`arn:aws:logs:<region>:<account>:log-group:<name>`). A log-stream ARN
(`log-group:<name>:*` or `...:log-stream:...`) stops granting them. Only
PutLogEvents, GetLogEvents, CreateLogStream and DeleteLogStream stay
stream-scoped.

Scans every IAM role's inline policies and every customer-managed policy in
the account. Reports each log-group action that a role or policy grants only
via log-stream ARNs (a grant of the same action on a group ARN or '*' in
another of its statements covers it). AWS-managed policies are skipped.

Needs the AWS CLI and iam:ListRoles, ListRolePolicies, GetRolePolicy,
ListPolicies and GetPolicyVersion (UBCPowerUserAccess has them).

Usage: python3 -I scripts/check_cloudwatch_logs_iam.py <aws-profile>
Exit code: 0 when nothing is affected, 1 when something is, 2 on errors.
See CLAUDE_HISTORY.md (2026-11-26) and AWS_COST_OPTIMIZATION_PLAN.md (F4).
"""
import json
import subprocess
import sys
from concurrent.futures import ThreadPoolExecutor

STREAM_ACTIONS = {"putlogevents", "getlogevents", "createlogstream", "deletelogstream"}


def aws(profile, *args):
    out = subprocess.run(["aws", *args, "--profile", profile, "--output", "json"],
                         capture_output=True, text=True)
    if out.returncode != 0:
        raise RuntimeError(out.stderr.strip().splitlines()[-1] if out.stderr.strip() else "error")
    return json.loads(out.stdout) if out.stdout.strip() else {}


def classify(arn):
    """'wide' ('*' or a logs wildcard), 'stream', 'group', or 'other'."""
    if arn == "*":
        return "wide"
    if not arn.startswith("arn:") or ":logs:" not in arn:
        return "other"
    tail = arn.split(":", 5)[5] if arn.count(":") >= 5 else ""
    if tail in ("*", "", "log-group:*"):
        return "wide"
    if ":log-stream:" in tail or tail.endswith(":*"):
        return "stream"
    if tail.startswith("log-group:"):
        return "group"
    return "other"


def check_docs(owner, docs):
    """Log-group actions granted only via log-stream ARNs across an owner's docs."""
    stream_only, on_group = {}, set()
    for pname, doc in docs:
        stmts = doc.get("Statement", [])
        stmts = [stmts] if isinstance(stmts, dict) else stmts
        for st in stmts:
            if st.get("Effect") != "Allow":
                continue
            acts = st.get("Action", [])
            acts = [acts] if isinstance(acts, str) else acts
            group_acts = [a for a in acts if a == "*" or (a.lower().startswith("logs:")
                          and a.split(":", 1)[1].lower() not in STREAM_ACTIONS)]
            if not group_acts:
                continue
            rs = st.get("Resource", [])
            rs = [rs] if isinstance(rs, str) else rs
            kinds = {classify(r) for r in rs}
            for a in group_acts:
                if {"group", "wide"} & kinds:
                    on_group.add(a.lower())
                elif "stream" in kinds:
                    stream_only.setdefault(a.lower(), []).append(f"{pname} on {rs}")
    return [f"AFFECTED {owner}: {a} via {'; '.join(where)}"
            for a, where in sorted(stream_only.items()) if a not in on_group]


def main():
    if len(sys.argv) != 2:
        sys.exit(__doc__)
    profile = sys.argv[1]

    def scan_role(role):
        try:
            names = aws(profile, "iam", "list-role-policies", "--role-name", role).get("PolicyNames", [])
            docs = [(f"inline:{pn}", aws(profile, "iam", "get-role-policy", "--role-name", role,
                                         "--policy-name", pn)["PolicyDocument"]) for pn in names]
            return check_docs(f"role/{role}", docs), []
        except RuntimeError as e:
            return [], [f"ERR role/{role}: {e}"]

    def scan_managed(p):
        try:
            v = aws(profile, "iam", "get-policy-version", "--policy-arn", p["Arn"],
                    "--version-id", p["DefaultVersionId"])
            return check_docs(f"managed/{p['PolicyName']} (attached {p['AttachmentCount']}x)",
                              [(p["Arn"], v["PolicyVersion"]["Document"])]), []
        except RuntimeError as e:
            return [], [f"ERR managed/{p['PolicyName']}: {e}"]

    try:
        roles = [r["RoleName"] for r in aws(profile, "iam", "list-roles")["Roles"]]
        managed = aws(profile, "iam", "list-policies", "--scope", "Local")["Policies"]
    except RuntimeError as e:
        sys.exit(f"ERR listing IAM roles/policies: {e}")
    print(f"Scanned {len(roles)} roles and {len(managed)} customer-managed policies", file=sys.stderr)

    hits, errs = [], []
    with ThreadPoolExecutor(max_workers=8) as ex:
        for h, e in list(ex.map(scan_role, roles)) + list(ex.map(scan_managed, managed)):
            hits += h
            errs += e

    print("\n".join(sorted(hits)) if hits else "No affected roles or policies")
    for e in errs:
        print(e, file=sys.stderr)
    sys.exit(2 if errs else 1 if hits else 0)


if __name__ == "__main__":
    main()
