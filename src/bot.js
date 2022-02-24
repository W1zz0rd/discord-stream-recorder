"use strict";

const Discord = require("discord.js");
const {TOKEN_USER, TOKEN_BOT} = require("../secrets/discord-tokens.json");
const fs = require("fs");
const {StreamRecorder} = require("./recorder.js");
const {
    startRecording,
    stopRecording,
    setPermissionLevel,
    listPermissionLevels,
    optOut,
    optIn,
    recordingInfo,
    setPrefix,
    reset,
    BotCommandError
} = require("./commands.js");

class StreamRecorderBot {
    constructor(opts) {
        const config = JSON.parse(fs.readFileSync("./config.json", {encoding: "utf-8"}));
        this.prefix = config.prefix;
        this._token = opts.botToken;
        this._userToken = opts.userToken;
        this._commands = {};
        opts.commands.forEach(cmd => {
            this._commands[cmd.name] = {
                ...cmd,
                exec: cmd.exec.bind(this),
            }
        });
        this._commands["help"] = this.generateHelpCommand();

        this.isRecording = null;
        this.permissions = config.permissions;
        this.optOuts = new Set([...config.optOuts]);

        this._client = new Discord.Client({
            intents: [
                Discord.Intents.FLAGS.GUILDS,
                Discord.Intents.FLAGS.GUILD_MEMBERS,
                Discord.Intents.FLAGS.GUILD_PRESENCES,
                Discord.Intents.FLAGS.GUILD_MESSAGES,
                Discord.Intents.FLAGS.GUILD_VOICE_STATES,
            ],
        });
    }

    init() {
        this._client.once("ready", async () => {
            this.streamRecorder = new StreamRecorder(this._userToken, this);
            await this.setPresence();
            console.log("BOT READY");
        });
        this.registerCommands();
        this._client.login(this._token);
    }

    /**
     * 3 for server owner, 2 for admins, 1 for users, 0 for everyone else.
     */
    async getUserPermissionLevel(guildUser) {
        const guild = guildUser.guild;
        const guildOwner = await guild.fetchOwner();
        if (guildUser.user.id === guildOwner.user.id) return 3;
        if (this.permissions[guild.id]) {
            if (this.permissions[guild.id].members) {
                if (this.permissions[guild.id].members[guildUser.user.id]) return this.permissions[guild.id].members[guildUser.user.id];
            }
            if (this.permissions[guild.id].roles) {
                return Math.max(...guildUser._roles.map(rId => this.permissions[guild.id].roles[rId] || 0));
            }
        }
        return 0;
    }

    async getMessageContext(message) {
        const cmdAuthor = await message.author.fetch();
        const guildId = message.guildId;
        const guild = await this._client.guilds.fetch(guildId);
        const guildUser = await guild.members.fetch(cmdAuthor.id);
        const guildUserPermLevel = await this.getUserPermissionLevel(guildUser);
        return {message, guild, guildUser, guildUserPermLevel}
    }

    registerCommands() {
        this._client.on("messageCreate", async (message) => {
            const messageContext = await this.getMessageContext(message);
            let messageContent = message.content;
            if (!messageContent.startsWith(this.prefix)) return;
            messageContent = messageContent.replace(new RegExp(`^${this.prefix.replace(/[-/\\^$*+?.()|[\]{}]/g, "\\$&")}`), "").trim();

            try {
                const [commandName, ...possibleCommandOptions] = messageContent.split(" ");
                const command = this._commands[commandName];
                if (!command) return;
                if (command.level > messageContext.guildUserPermLevel) {
                    if (messageContext.guildUserPermLevel === 0) return;
                    throw new BotCommandError("You don't have permissions to use that command.");
                }
                const commandOptions = possibleCommandOptions.filter(o => (command.options || {})[o] != null);
                if (commandOptions.map(o => command.options[o].level).find(optLvl => optLvl > messageContext.guildUserPermLevel)) {
                    if (messageContext.guildUserPermLevel === 0) return;
                    throw new BotCommandError("You don't have permissions to use that command option.");
                }
                this._lastCommand = message;
                await command.exec(messageContext, commandOptions);
            } catch (err) {
                if (err instanceof BotCommandError) {
                    await message.reply(err.message || "Encountered unknown error");
                    console.error(err);
                } else {
                    await message.reply(`Encountered unknown error, resetting...`)
                    console.error(err);
                    await this.reset();
                }
            }
        })
    }

    setPresence() {
        if (this.isRecording) {
            this._client.user.presence.set({
                status: "dnd",
                activities: [
                    {
                        name: "a Stream...",
                        type: "WATCHING",
                    }
                ],
            });
        } else {
            this._client.user.presence.set({
                status: "online",
                activities: [
                    {
                        name: `Commands. ${this.prefix}help`,
                        type: "LISTENING"
                    }
                ]
            });
        }
    }

    saveConfigToFile() {
        const config = {
            permissions: this.permissions,
            optOuts: [...this.optOuts],
            prefix: this.prefix,
        }
        fs.writeFileSync("./config.json", JSON.stringify(config, null, 2));
    }

    generateHelpCommand() {
        return {
            name: "help",
            description: {
                short: `Display this text. Use \`${this.prefix}help command\` to display more info about a command.`,
                long: `Display this text. Use \`${this.prefix}help command\` to display more info about a command.`,
                example: `help ${Object.keys(this._commands)[0]}`
            },
            level: 0,
            options: Object.keys(this._commands).map(n => ({[n]: {description: `Display info about the \`${n}\` command.`}})).reduce((a, b) => ({...a, ...b}), {}),
            exec: async (cmdContext, cmdOptions) => {
                if (cmdOptions.length !== 1) {
                    const renderCommandHelp = (cmd) => {
                        return `${this.prefix}${cmd.name} - ${cmd.description.short}\n`
                    }
                    cmdContext.message.channel.send({
                        embeds: [
                            {
                                title: 'Available Commands',
                                description: `${Object.values(this._commands).filter(c => c.level <= cmdContext.guildUserPermLevel).map(renderCommandHelp).join("")}`,
                            }
                        ]
                    });
                } else {
                    // print help message for specific command
                    const commandName = cmdOptions[0];
                    const command = this._commands[commandName];
                    if (command == null) {
                        cmdContext.message.channel.send(`Unknown command - \`${commandName}\``);
                        return;
                    }
                    const renderCommandOptions = (opts) => {
                        if (opts.length === 0) return "";
                        return `**Options**:
                        ${opts.map(([optName, opt]) => `\`${optName}\` ${opt.description}\n`).join("")}
                        `;
                    }
                    const renderCommandMentions = (cmd) => {
                        if (command.mentions == null) return "";
                        return `**Mentions**:
                        ${Object.entries(cmd.mentions).map(([mType, m]) => `\`@${mType}\` ${m.description}\n`).join("")}
                        `;
                    }
                    const cmdOptsFiltered = command.options ? Object.entries(command.options).filter(([optName, opt]) => opt.level <= cmdContext.guildUserPermLevel) : [];
                    cmdContext.message.channel.send({
                        embeds: [
                            {
                                title: `Help: ${this.prefix}${commandName}`,
                                description: `
                                ${command.description.long}\n
                                **Synopsis**:
                                \`${this.prefix}${commandName}${cmdOptsFiltered.length ? " [...OPTIONS]" : ""}${command.mentions ? " [...MENTIONS]" : ""}\`\n
                                ${renderCommandOptions(cmdOptsFiltered)}${renderCommandMentions(command)}**Example**
                                \`${this.prefix}${command.description.example}\`
                                `,
                            }
                        ]
                    });
                }
            }
        }
    }

    async reset() {
        if (this.streamRecorder) await this.streamRecorder.reset();
        await this.setPresence();
    }
}

if (require.main === module) {
    const streamRecorderBot = new StreamRecorderBot({
        botToken: TOKEN_BOT,
        userToken: TOKEN_USER,
        commands: [
            startRecording,
            stopRecording,
            setPermissionLevel,
            listPermissionLevels,
            optOut,
            optIn,
            recordingInfo,
            setPrefix,
            reset,
        ],
    });
    streamRecorderBot.init();
} else {
    module.exports = {StreamRecorderBot};
}
