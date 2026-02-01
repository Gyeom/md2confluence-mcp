/**
 * Confluence REST API Client
 */

export class ConfluenceClient {
  private baseUrl: string;
  private auth: string;

  constructor(baseUrl: string, email: string, token: string) {
    this.baseUrl = baseUrl.replace(/\/$/, "");
    this.auth = Buffer.from(`${email}:${token}`).toString("base64");
  }

  private async request(path: string, options: RequestInit = {}): Promise<any> {
    const url = `${this.baseUrl}/rest/api${path}`;

    const response = await fetch(url, {
      ...options,
      headers: {
        Authorization: `Basic ${this.auth}`,
        "Content-Type": "application/json",
        ...options.headers,
      },
    });

    if (!response.ok) {
      const error = await response.text();
      throw new Error(`Confluence API error (${response.status}): ${error}`);
    }

    return response.json();
  }

  /**
   * Create a new page
   */
  async createPage(
    spaceKey: string,
    title: string,
    content: string,
    parentId?: string
  ): Promise<{ id: string; url: string; version: number }> {
    const body: any = {
      type: "page",
      title,
      space: { key: spaceKey },
      body: {
        storage: {
          value: content,
          representation: "storage",
        },
      },
    };

    if (parentId) {
      body.ancestors = [{ id: parentId }];
    }

    const result = await this.request("/content", {
      method: "POST",
      body: JSON.stringify(body),
    });

    return {
      id: result.id,
      url: `${this.baseUrl}${result._links.webui}`,
      version: result.version.number,
    };
  }

  /**
   * Update an existing page
   */
  async updatePage(
    pageId: string,
    title: string,
    content: string,
    version: number
  ): Promise<{ id: string; url: string; version: number }> {
    const body = {
      type: "page",
      title,
      version: { number: version },
      body: {
        storage: {
          value: content,
          representation: "storage",
        },
      },
    };

    const result = await this.request(`/content/${pageId}`, {
      method: "PUT",
      body: JSON.stringify(body),
    });

    return {
      id: result.id,
      url: `${this.baseUrl}${result._links.webui}`,
      version: result.version.number,
    };
  }

  /**
   * Get page info
   */
  async getPage(pageId: string): Promise<{ id: string; title: string; version: number }> {
    const result = await this.request(`/content/${pageId}?expand=version`);

    return {
      id: result.id,
      title: result.title,
      version: result.version.number,
    };
  }

  /**
   * Upload attachment
   */
  async uploadAttachment(pageId: string, filename: string, data: Buffer): Promise<void> {
    const url = `${this.baseUrl}/rest/api/content/${pageId}/child/attachment`;

    const formData = new FormData();
    formData.append("file", new Blob([data]), filename);

    const response = await fetch(url, {
      method: "POST",
      headers: {
        Authorization: `Basic ${this.auth}`,
        "X-Atlassian-Token": "nocheck",
      },
      body: formData,
    });

    if (!response.ok) {
      const error = await response.text();
      throw new Error(`Failed to upload attachment: ${error}`);
    }
  }

  /**
   * List spaces
   */
  async listSpaces(limit: number = 25): Promise<any[]> {
    const result = await this.request(`/space?limit=${limit}`);
    return result.results;
  }

  /**
   * Search pages
   */
  async searchPages(query: string, spaceKey?: string, limit: number = 10): Promise<any[]> {
    let cql = `type=page AND text~"${query}"`;
    if (spaceKey) {
      cql += ` AND space="${spaceKey}"`;
    }

    const result = await this.request(
      `/content/search?cql=${encodeURIComponent(cql)}&limit=${limit}`
    );

    return result.results.map((r: any) => ({
      id: r.id,
      title: r.title,
      spaceKey: r.space?.key || "unknown",
      url: `${this.baseUrl}${r._links.webui}`,
    }));
  }
}
