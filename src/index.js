import "dotenv/config";
import path from "node:path";
import { Client, GatewayIntentBits, REST, Routes, SlashCommandBuilder } from "discord.js";
import { ApiFootballClient } from "./api-football.js";
import { fixtureLabel, goalKey, isHaalandGoal, isHaalandPlaying } from "./football-data.js";
import { loadConfig } from "./config.js";
import { GifProvider } from "./gif-provider.js";
import { RedditMontageWorker } from "./reddit-montage.js";
import { loadState, rememberGoal, saveState } from "./state-store.js";

function goalMinute(event) {
  const elapsed = event.time?.elapsed ?? "?";
  const extra = event.time?.extra ? `+${event.time.extra}` : "";
  return `${elapsed}${extra}'`;
}

function goalMessage(fixture, event) {
  const team = event.team?.name ?? "Haaland's team";
  const opponent = event.team?.id === fixture.teams?.home?.id
    ? fixture.teams?.away?.name
    : fixture.teams?.home?.name;
  const detail = event.detail && event.detail !== "Normal Goal" ? ` (${event.detail.toLowerCase()})` : "";
  return `⚽ **Erling Haaland has scored!** ${team} vs ${opponent ?? "the opponent"} — ${goalMinute(event)}${detail}`;
}

function gifMessage(content, gif) {
  const message = {
    content: `${content}\n${gif.sourceUrl ? `[GIF source](${gif.sourceUrl})` : ""}`.trim(),
    embeds: [{ image: { url: gif.attachmentName ? `attachment://${gif.attachmentName}` : gif.url }, footer: { text: `Random GIF via ${gif.provider}` } }]
  };
  if (gif.attachmentPath) {
    message.files = [{ attachment: gif.attachmentPath, name: gif.attachmentName }];
  }
  return message;
}

function goalBotCommand() {
  return new SlashCommandBuilder()
    .setName("goalbot")
    .setDescription("Post a Haaland goal GIF")
    .addSubcommand((subcommand) =>
      subcommand
        .setName("goal")
        .setDescription("Manually post a random Haaland goal GIF")
    )
    .addSubcommand((subcommand) =>
      subcommand
        .setName("reddit")
        .setDescription("Convert a Reddit goal clip to WebP and post it")
        .addStringOption((option) =>
          option
            .setName("url")
            .setDescription("The Reddit post URL containing the goal clip")
            .setRequired(true)
        )
    )
    .toJSON();
}

async function registerCommands(client, config) {
  const rest = new REST({ version: "10" }).setToken(config.discordToken);
  const route = config.discordGuildId
    ? Routes.applicationGuildCommands(client.user.id, config.discordGuildId)
    : Routes.applicationCommands(client.user.id);
  await rest.put(route, { body: [goalBotCommand()] });
  console.log(`Registered /goalbot goal ${config.discordGuildId ? "for the configured server" : "globally"}`);
}

class GoalTracker {
  constructor(config, channel, api, gifProvider, state, onHaalandGoal = null) {
    this.config = config;
    this.channel = channel;
    this.api = api;
    this.gifProvider = gifProvider;
    this.state = state;
    this.running = false;
    this.lastReconcileAt = 0;
    this.redditMonitoringAllowed = false;
    this.onHaalandGoal = onHaalandGoal;
  }

  async scanFixture(fixture, { suppressPosts = false } = {}) {
    const fixtureId = fixture.fixture?.id;
    if (!fixtureId) return;

    const events = fixture.events ?? [];
    for (const event of events.filter((item) => isHaalandGoal(item, this.config.apiFootballPlayerId))) {
      const key = goalKey(fixtureId, event, "api-football");
      if (this.state.processedGoalKeys.includes(key)) continue;

      if (!suppressPosts) {
        const gif = await this.gifProvider.randomGif();
        await this.channel.send(gifMessage(goalMessage(fixture, event), gif));
        console.log(`Posted goal ${key} for ${fixtureLabel(fixture)}`);
      } else {
        console.log(`Bootstrapped existing goal ${key} without posting`);
      }
      rememberGoal(this.state, key);
      await saveState(this.config.dataDir, this.state);
      if (!suppressPosts && this.onHaalandGoal) await this.onHaalandGoal({ fixture, event });
    }

    this.state.fixtureScans[String(fixtureId)] = Date.now();
  }

  async poll() {
    if (this.running) return;
    this.running = true;
    try {
      const suppressPosts = !this.state.bootstrapped && !this.config.backfillExistingGoals;
      const fixtureResults = await Promise.all(
        this.config.apiFootballTeamIds.flatMap((teamId) => this.config.apiFootballLeagueIds.map((leagueId) =>
          this.api.getMatches(leagueId, this.config.season, teamId)
        ))
      );
      const recentFixtures = [...new Map(
        fixtureResults.flat().map((fixture) => [String(fixture.fixture?.id), fixture])
      ).values()];
      this.redditMonitoringAllowed = recentFixtures.some((fixture) => isHaalandPlaying(
        fixture,
        this.config.apiFootballPlayerId,
        this.config.manchesterCityTeamId
      ));
      for (const fixture of recentFixtures) await this.scanFixture(fixture, { suppressPosts });

      if (!this.state.bootstrapped) {
        this.state.bootstrapped = true;
        if (!this.config.backfillExistingGoals) {
          console.log("Initial scan complete; existing Haaland goals were suppressed.");
        }
      }
      await saveState(this.config.dataDir, this.state);
    } catch (error) {
      this.redditMonitoringAllowed = false;
      console.error(`Poll failed: ${error.stack || error.message}`);
    } finally {
      this.running = false;
    }
  }

  canMonitorReddit() {
    return this.redditMonitoringAllowed;
  }
}

async function main() {
  const config = loadConfig();
  const client = new Client({ intents: [GatewayIntentBits.Guilds] });
  const api = new ApiFootballClient(config.apiFootballKey, undefined, undefined, {
    backfillDays: config.backfillExistingGoals ? config.backfillDays : 0
  });
  const gifProvider = new GifProvider(config);
  const state = await loadState(config.dataDir);
  const redditWorker = config.redditEnabled ? new RedditMontageWorker(config) : null;

  client.on("interactionCreate", async (interaction) => {
    if (!interaction.isChatInputCommand() || interaction.commandName !== "goalbot") return;
    const subcommand = interaction.options.getSubcommand();
    if (!["goal", "reddit"].includes(subcommand)) return;

    if (interaction.channelId !== config.discordChannelId) {
      await interaction.reply({
        content: "Please use `/goalbot goal` in the configured Haaland goal channel.",
        ephemeral: true
      });
      return;
    }

    try {
      await interaction.deferReply();

      if (subcommand === "reddit") {
        if (!redditWorker) {
          await interaction.editReply("Reddit importing is disabled. Set REDDIT_CLIENT_ID and REDDIT_CLIENT_SECRET, then restart the bot.");
          return;
        }
        const postUrl = interaction.options.getString("url", true);
        const result = await redditWorker.processPostUrl(postUrl);
        const filename = path.basename(result.outputPath);
        await interaction.editReply(gifMessage(`🎬 **${result.post.title || "Reddit goal clip"}**\n[Reddit source](${postUrl})`, {
          attachmentPath: result.outputPath,
          attachmentName: filename,
          provider: "Reddit montage",
          sourceUrl: postUrl
        }));
        console.log(`Posted Reddit test clip ${result.post.id} as ${filename}`);
        return;
      }

      const gif = await gifProvider.randomGif();
      await interaction.editReply(gifMessage(`🎉 **${interaction.user.displayName} called a goal!**`, gif));
    } catch (error) {
      console.error(`Manual GIF command failed: ${error.stack || error.message}`);
      const message = "I couldn't fetch a GIF right now. Check the configured GIF URLs or Tenor settings.";
      if (interaction.deferred || interaction.replied) await interaction.editReply(message);
      else await interaction.reply({ content: message, ephemeral: true });
    }
  });

  client.once("clientReady", async (readyClient) => {
    try {
      await registerCommands(readyClient, config);
    } catch (error) {
      console.error(`Slash-command registration failed: ${error.stack || error.message}`);
    }

    const channel = await readyClient.channels.fetch(config.discordChannelId);
    if (!channel?.isTextBased()) throw new Error("DISCORD_CHANNEL_ID is not a text-based channel");
    console.log(`Logged in as ${readyClient.user.tag}; tracking API-Football teams ${config.apiFootballTeamIds.join(", ")} across leagues ${config.apiFootballLeagueIds.join(", ")} for season ${config.season}-${config.season + 1}`);

    if (redditWorker) {
      redditWorker.setPublisher(async ({ outputPath, posts }) => {
        const filename = path.basename(outputPath);
        const title = posts.length === 1 ? posts[0].title : `${posts.length} new Haaland Reddit clips`;
        await channel.send(gifMessage(`🎬 **${title}**`, {
          attachmentPath: outputPath,
          attachmentName: filename,
          provider: "Reddit montage"
        }));
        console.log(`Posted automatic Reddit montage ${filename}`);
      });
    }

    const tracker = new GoalTracker(
      config,
      channel,
      api,
      gifProvider,
      state,
      async () => redditWorker?.noteHaalandGoal()
    );
    await tracker.poll();
    setInterval(() => tracker.poll(), config.pollIntervalSeconds * 1000);

    if (redditWorker) {
      const runRedditPoll = () => redditWorker.poll().catch((error) => {
        console.error(`Reddit worker failed: ${error.stack || error.message}`);
      });
      const runGatedRedditPoll = () => {
        if (!tracker.canMonitorReddit()) {
          redditWorker.clearPending();
          return;
        }
        return runRedditPoll();
      };
      await runGatedRedditPoll();
      setInterval(runGatedRedditPoll, config.redditPollIntervalSeconds * 1000);
      console.log(`Reddit montage worker gated to live Haaland appearances in: ${config.redditSubreddits.map((name) => `r/${name}`).join(", ")}`);
    } else {
      console.log("Reddit montage worker disabled; set REDDIT_CLIENT_ID and REDDIT_CLIENT_SECRET to enable it.");
    }
  });

  client.on("error", (error) => console.error(`Discord client error: ${error.stack || error.message}`));
  await client.login(config.discordToken);
}

main().catch((error) => {
  console.error(error.stack || error.message);
  process.exitCode = 1;
});
