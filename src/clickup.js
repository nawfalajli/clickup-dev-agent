// Minimal ClickUp API v2 client (https://clickup.com/api).
export class ClickUp {
  constructor({ token, apiUrl }) {
    this.token = token;
    this.apiUrl = apiUrl.replace(/\/$/, '');
  }

  async request(method, pathname, body) {
    const res = await fetch(this.apiUrl + pathname, {
      method,
      headers: { Authorization: this.token, 'Content-Type': 'application/json' },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    const text = await res.text();
    if (!res.ok) throw new Error(`ClickUp ${method} ${pathname} -> ${res.status}: ${text.slice(0, 300)}`);
    return text ? JSON.parse(text) : {};
  }

  async me() {
    return (await this.request('GET', '/user')).user;
  }

  /** Every open task (subtasks included) assigned to userId in the workspace, oldest first. */
  async assignedTasks(teamId, userId, statuses = []) {
    const tasks = [];
    for (let page = 0; ; page++) {
      const q = new URLSearchParams({
        page: String(page),
        subtasks: 'true',
        include_closed: 'false',
        include_markdown_description: 'true',
        order_by: 'created',
        reverse: 'true',
      });
      q.append('assignees[]', String(userId));
      for (const s of statuses) q.append('statuses[]', s);
      const { tasks: batch = [], last_page: lastPage } = await this.request('GET', `/team/${teamId}/task?${q}`);
      tasks.push(...batch);
      if (lastPage === true || batch.length < 100) return tasks;
    }
  }

  comment(taskId, text) {
    return this.request('POST', `/task/${taskId}/comment`, { comment_text: text, notify_all: false });
  }

  setStatus(taskId, status) {
    return this.request('PUT', `/task/${taskId}`, { status });
  }
}
