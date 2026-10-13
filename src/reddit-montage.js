import fs from "node:fs/promises";
import { createWriteStream } from "node:fs";
import path from "node:path";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";
import { spawn } from "node:child_process";
import ffmpegPath from "ffmpeg-static";

const TOKEN_URL = "https://www.reddit.com/api/v1/access_token";
const OAUTH_BASE_URL = "https://oauth.reddit.com";

function postData(post) {
  return post?.data ?? post;
}

export function findRedditVideoUrl(post) {
  const data = postData(post);
  const candidates = [
    data?.secure_media?.reddit_video?.fallback_url,
    data?.media?.reddit_video?.fallback_url,
    data?.preview?.reddit_video_preview?.fallback_url,
    data?.url_overridden_by_dest,
    data?.url
  ];
  return candidates.find((url) => typeof url === "string" && /\.(mp4|webm)(?:\?|$)/i.test(url)) ?? null;
}

export function isCandidatePost(post, titlePattern) {
  const data = postData(post);
  if (!data || !findRedditVideoUrl(data)) return false;
  return new RegExp(titlePattern, "i").test(data.title ?? "");
}

function redditPostIdFromUrl(postUrl) {
  const url = new URL(postUrl);
  if (!/(^|\.)reddit\.com$/i.test(url.hostname)) {
    throw new Error("The URL must be a Reddit post URL.");
  }
  const match = url.pathname.match(/\/comments\/([a-z0-9]+)/i);
  if (!match) throw new Error("The URL must point to a Reddit post.");
  return match[1];
}

async function fileExists(filePath) {
  try {
    await fs.access(filePath);
    return true;
  } catch {
    return false;
  }
}

async function runFfmpeg(args) {
  await new Promise((resolve, reject) => {
    const child = spawn(ffmpegPath, args, { windowsHide: true });
    let stderr = "";
    child.stderr.on("data", (chunk) => { stderr += chunk.toString(); });
    child.on("error", reject);
    child.on("close", (code) => {
      if (code === 0) resolve();
      else reject(new Error(`FFmpeg exited with code ${code}: ${stderr.slice(-2000)}`));
    });
  });
}

async function writeConcatList(paths, outputPath) {
  const lines = paths.map((filePath) => `file '${filePath.replaceAll("\\", "/").replaceAll("'", "'\\''")}'`);
  await fs.writeFile(outputPath, `${lines.join("\n")}\n`, "utf8");
}

export async function buildMontage(config, clipPaths) {
  if (clipPaths.length === 0) return null;
  await fs.mkdir(config.gifDirectory, { recursive: true });
  await fs.mkdir(config.redditClipDirectory, { recursive: true });

  const concatPath = path.join(config.redditClipDirectory, "concat.txt");
  await writeConcatList(clipPaths, concatPath);
  const extension = config.redditMontageFormat;
  const outputPath = path.join(config.gifDirectory, `reddit-super.${extension}`);
  const inputArgs = ["-y", "-f", "concat", "-safe", "0", "-i", concatPath, "-t", String(config.redditMontageMaxSeconds)];

  if (extension === "gif") {
    await runFfmpeg([
      ...inputArgs,
      "-vf",
      "fps=10,scale=480:-2:flags=lanczos,split[s0][s1];[s0]palettegen=max_colors=128[p];[s1][p]paletteuse=dither=sierra2_4a",
      "-loop", "0",
      outputPath
    ]);
  } else {
    await runFfmpeg([
      ...inputArgs,
      "-vf", "fps=10,scale=480:-2:flags=lanczos",
      "-c:v", "libwebp",
      "-q:v", "60",
      "-loop", "0",
      outputPath
    ]);
  }
  return outputPath;
}

export class RedditClient {
  constructor(config, fetchImpl = globalThis.fetch) {
    this.config = config;
    this.fetch = fetchImpl;
    this.accessToken = null;
    this.accessTokenExpiresAt = 0;
  }

  async getAccessToken() {
    if (this.accessToken && Date.now() < this.accessTokenExpiresAt) return this.accessToken;
    const basic = Buffer.from(`${this.config.redditClientId}:${this.config.redditClientSecret}`).toString("base64");
    const response = await this.fetch(TOKEN_URL, {
      method: "POST",
      headers: {
        authorization: `Basic ${basic}`,
        "user-agent": this.config.redditUserAgent,
        "content-type": "application/x-www-form-urlencoded"
      },
      body: "grant_type=client_credentials"
    });
    const body = await response.json();
    if (!response.ok || !body.access_token) throw new Error(`Reddit OAuth ${response.status}: ${body.error || body.message || response.statusText}`);
    this.accessToken = body.access_token;
    this.accessTokenExpiresAt = Date.now() + Math.max(60, (body.expires_in ?? 3600) - 60) * 1000;
    return this.accessToken;
  }

  async newPosts(subreddit) {
    const token = await this.getAccessToken();
    const url = new URL(`${OAUTH_BASE_URL}/r/${encodeURIComponent(subreddit)}/new`);
    url.searchParams.set("limit", "25");
    url.searchParams.set("raw_json", "1");
    const response = await this.fetch(url, {
      headers: {
        authorization: `Bearer ${token}`,
        "user-agent": this.config.redditUserAgent,
        accept: "application/json"
      }
    });
    const body = await response.json();
    if (!response.ok) throw new Error(`Reddit listing ${response.status}: ${body.message || response.statusText}`);
    return body.data?.children ?? [];
  }

  async postByUrl(postUrl) {
    const token = await this.getAccessToken();
    const postId = redditPostIdFromUrl(postUrl);
    const url = new URL(`${OAUTH_BASE_URL}/comments/${postId}`);
    url.searchParams.set("raw_json", "1");
    const response = await this.fetch(url, {
      headers: {
        authorization: `Bearer ${token}`,
        "user-agent": this.config.redditUserAgent,
        accept: "application/json"
      }
    });
    const body = await response.json();
    if (!response.ok) throw new Error(`Reddit post lookup ${response.status}: ${body.message || response.statusText}`);
    const post = body?.[0]?.data?.children?.[0];
    if (!post) throw new Error("Reddit did not return a post for that URL.");
    return post;
  }
}

export class RedditMontageWorker {
  constructor(config, fetchImpl = globalThis.fetch) {
    this.config = config;
    this.client = new RedditClient(config, fetchImpl);
    this.statePath = path.join(config.dataDir, "reddit-state.json");
    this.running = false;
    this.publisher = null;
    this.goalPending = false;
    this.pendingClipPaths = [];
    this.pendingPosts = [];
  }

  setPublisher(publisher) {
    this.publisher = publisher;
  }

  async noteHaalandGoal() {
    this.goalPending = true;
    if (!this.running) await this.publishPending();
  }

  clearPending() {
    this.goalPending = false;
    this.pendingClipPaths = [];
    this.pendingPosts = [];
  }

  async publishPending() {
    if (!this.goalPending || this.pendingClipPaths.length === 0 || !this.publisher) return;
    const clipPaths = this.pendingClipPaths.slice(-this.config.redditMaxClips);
    const outputPath = await buildMontage(this.config, clipPaths);
    const posts = [...this.pendingPosts];
    await this.publisher({ outputPath, posts });
    this.clearPending();
  }

  async loadState() {
    try {
      return JSON.parse(await fs.readFile(this.statePath, "utf8"));
    } catch (error) {
      if (error.code === "ENOENT") return { processedPostIds: [] };
      throw error;
    }
  }

  async saveState(state) {
    await fs.mkdir(this.config.dataDir, { recursive: true });
    state.processedPostIds = (state.processedPostIds ?? []).slice(-1000);
    await fs.writeFile(this.statePath, `${JSON.stringify(state, null, 2)}\n`, "utf8");
  }

  async downloadPost(post, videoUrl) {
    const data = postData(post);
    const postId = String(data.id);
    const extension = new URL(videoUrl).pathname.toLowerCase().endsWith(".webm") ? ".webm" : ".mp4";
    const outputPath = path.join(this.config.redditClipDirectory, `${postId}${extension}`);
    if (await fileExists(outputPath)) return outputPath;

    await fs.mkdir(this.config.redditClipDirectory, { recursive: true });
    const response = await this.client.fetch(videoUrl, { headers: { "user-agent": this.config.redditUserAgent } });
    if (!response.ok || !response.body) throw new Error(`Video download ${response.status}: ${videoUrl}`);
    await pipeline(Readable.fromWeb(response.body), createWriteStream(outputPath));
    return outputPath;
  }

  async processPostUrl(postUrl) {
    const post = await this.client.postByUrl(postUrl);
    const data = postData(post);
    const videoUrl = findRedditVideoUrl(data);
    if (!videoUrl) throw new Error("That Reddit post does not contain a directly downloadable MP4 or WebM video.");
    const clipPath = await this.downloadPost(data, videoUrl);
    const outputPath = await buildMontage(this.config, [clipPath]);
    return { post: data, outputPath, videoUrl };
  }

  async poll() {
    if (this.running) return;
    this.running = true;
    try {
      const state = await this.loadState();
      const processed = new Set(state.processedPostIds ?? []);
      const downloadedPosts = [];

      for (const subreddit of this.config.redditSubreddits) {
        const posts = await this.client.newPosts(subreddit);
        for (const post of posts) {
          const data = postData(post);
          if (!data?.id || processed.has(data.id)) continue;
          if (isCandidatePost(data, this.config.redditTitlePattern)) {
            const videoUrl = findRedditVideoUrl(data);
            try {
              const clipPath = await this.downloadPost(data, videoUrl);
              this.pendingClipPaths.push(clipPath);
              this.pendingPosts.push(data);
              downloadedPosts.push(data);
              console.log(`Downloaded Reddit highlight candidate: ${data.title}`);
            } catch (error) {
              console.error(`Reddit video download failed for ${data.id}: ${error.message}`);
              continue;
            }
          }
          processed.add(data.id);
        }
      }

      if (downloadedPosts.length > 0) {
        await this.saveState({ processedPostIds: [...processed] });
        if (this.goalPending) await this.publishPending();
        else console.log(`Queued ${downloadedPosts.length} Reddit Haaland clip(s) until a Haaland goal is detected.`);
        return;
      }
      await this.saveState({ processedPostIds: [...processed] });
    } finally {
      this.running = false;
    }
  }
}
