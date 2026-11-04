# HTTP fallback when MCP is unavailable

If the **spekios** CLI is installed and connected, prefer **spekios tools call <name> --input <json>**; it handles credentials and retry receipts.

Otherwise use a trusted HTTP client with redirects disabled. Use the configured Spekios origin: **https://app.spekios.com** for the hosted app, or **SCOUT_API_URL** for a local API (default **http://127.0.0.1:18080**). Send **Authorization: Bearer** using a native agent credential from the user's local secret configuration; browser pairing through **scout-mcp login** avoids sharing an operator key. MCP OAuth tokens only work on **/mcp**. Use the server origin bound to that saved credential; do not reuse it at a different origin. Do not print the token or put it in a URL or skill file.

If there is no connection or token, give setup guidance. The optional loopback GUI bypass is not a general authentication mechanism. Installing this skill does not connect MCP or transfer a model subscription.

Discover current tools with **GET /v1/agent/tools**. Call **POST /v1/agent/tools/{name}**, sending the argument object directly:

~~~http
POST /v1/agent/tools/scout_status
Content-Type: application/json
Authorization: Bearer <locally configured token>

{}
~~~

This example only reads status. For requested exploration, follow SKILL.md with **scout_start_exploration**, a saved generated **job_id**, and the requested **url**. Inspect **structuredContent** and **isError** in the returned tool envelope. HTTP 200 can mean admission, not completion. Domain failures retain their HTTP status. Do not retry changed arguments under an existing ID.

For read-only follow-up, pass the saved selector to **scout_get_progress**, then **scout_get_report**. Follow the report's complete continuation arguments, including **expected_snapshot**.

Ordinary REST alternatives:

- **POST /v1/browser-jobs** uses **kind: explore** and **target_url** instead of the tool's **url**; new admission is 202 and an identical retry is 200.
- **GET /v1/browser-jobs/{job_id}/progress** reads lightweight progress.
- **GET /v1/browser-jobs/{job_id}/report** reads the report with pagination query parameters.
- **GET /v1/projects** (or **scout_list_projects**) lists known project IDs with the model and limits a new run in each would use; **GET /v1/projects/{project_id}** reads one. Send **project_id** with a job to use its project's model, or **model** to choose one for that run only.

Request bodies are capped at 64 KiB and structured tool replies at 128 KiB. Reduce page size after an oversized result. Use the live schemas for additional options instead of guessing arguments.
