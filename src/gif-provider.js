import fs from "node:fs/promises";
import path from "node:path";

export class GifProvider {
  constructor(config, fetchImpl = globalThis.fetch, random = Math.random) {
    this.config = config;
    this.fetch = fetchImpl;
    this.random = random;
  }

  async localGifs() {
    if (!this.config.gifDirectory) return [];

    let entries;
    try {
      entries = await fs.readdir(this.config.gifDirectory, { withFileTypes: true });
    } catch (error) {
      if (error.code === "ENOENT") {
        throw new Error(`GIF_DIRECTORY does not exist: ${this.config.gifDirectory}`);
      }
      throw error;
    }

    const maxBytes = this.config.maxGifFileBytes ?? 8 * 1024 * 1024;
    const candidates = entries.filter((entry) => entry.isFile() && /\.(gif|webp)$/i.test(entry.name));
    const localGifs = await Promise.all(candidates.map(async (entry) => {
      const attachmentPath = path.join(this.config.gifDirectory, entry.name);
      const file = await fs.stat(attachmentPath);
      if (file.size > maxBytes) return null;
      return {
        attachmentPath,
        attachmentName: entry.name,
        provider: "local GIF library"
      };
    }));

    return localGifs.filter(Boolean);
  }

  async randomGif() {
    const localGifs = await this.localGifs();
    const candidates = [
      ...localGifs,
      ...this.config.gifUrls.map((url) => ({ url, sourceUrl: url, provider: "your GIF list" }))
    ];

    if (candidates.length > 0) {
      return candidates[Math.floor(this.random() * candidates.length)];
    }

    const url = new URL("https://tenor.googleapis.com/v2/search");
    url.searchParams.set("q", this.config.tenorQuery);
    url.searchParams.set("key", this.config.tenorApiKey);
    url.searchParams.set("client_key", this.config.tenorClientKey);
    url.searchParams.set("limit", "20");
    url.searchParams.set("random", "true");
    url.searchParams.set("contentfilter", "high");
    url.searchParams.set("media_filter", "gif");

    const response = await this.fetch(url, { headers: { accept: "application/json" } });
    const body = await response.json();
    if (!response.ok) throw new Error(`Tenor ${response.status}: ${body.error || response.statusText}`);

    const results = (body.results ?? []).filter((result) => result.media_formats?.gif?.url);
    if (results.length === 0) throw new Error("Tenor returned no usable GIFs");
    const result = results[Math.floor(this.random() * results.length)];
    return {
      url: result.media_formats.gif.url,
      sourceUrl: result.itemurl || result.url || result.media_formats.gif.url,
      provider: "Tenor"
    };
  }
}
