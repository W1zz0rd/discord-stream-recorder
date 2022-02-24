class BotCommandError extends Error {
    constructor(message) {
        super(message);
    }
}

const startRecording = {
    name: "start",
    description: {
        short: "Start recording a stream.",
        long: "Start recording a stream. If no user is mentioned, record your own stream. The target user must be in a voice channel and streaming.",
        example: "start @User#1234"
    },
    level: 1,
    mentions: {
        user: {
            description: "Single user: record mentioned users stream"
        }
    },
    exec: async function (messageContext, commandOptions) {
        const {message, guild, guildUser, guildUserPermLevel} = messageContext;

        if (this.isRecording) throw new BotCommandError("Already recording...");
        const targetGuildUser = (message.mentions && message.mentions.members && message.mentions.members.first()) || guildUser;
        if (this.optOuts.has(targetGuildUser.user.id)) throw new BotCommandError("The user doesn't want to be recorded.");
        if (!targetGuildUser.voice.channelId) throw new BotCommandError("The user isn't in a voice channel.");
        if (!targetGuildUser.voice.streaming) throw new BotCommandError("The user isn't streaming.");
        const channelToRecord = targetGuildUser.voice.channel;

        const starting = await message.reply("Starting...");
        await this.streamRecorder.initRecording(channelToRecord, targetGuildUser.user);
        await this.streamRecorder.startRecording();
        await starting.edit("Started recording.");

        this.isRecording = true;
        this.recordingOwner = targetGuildUser.user.id;
        await this.setPresence();
    }
}

function calcTimeDiff(t1, t2) {
    const msToS = 1000;
    const msToMin = msToS * 60
    const msToH = msToMin * 60;
    let timeDiff = t2 - t1;
    const hours = Math.floor(timeDiff / msToH);
    timeDiff -= hours * msToH;
    const mins = Math.floor(timeDiff / msToMin);
    timeDiff -= mins * msToMin;
    const secs = Math.floor(timeDiff / msToS);
    return `${String(hours).padStart(2, "0")}:${String(mins).padStart(2, "0")}:${String(secs).padStart(2, "0")}`;

}

const stopRecording = {
    name: "stop",
    description: {
        short: "Stop the current recording.",
        long: "Stop the current recording. You must be the recording's owner",
        example: "stop"
    },
    level: 1,
    options: {
        "--force": {
            description: "Use admin privileges to end the recording, regardless if you own it or not.",
            level: 2,
        }
    },
    exec: async function (messageContext, commandOptions) {
        const {message, guild, guildUser, guildUserPermLevel} = messageContext;
        if (!this.isRecording) throw new BotCommandError("Currently not recording.");
        if (commandOptions.includes("--force")) {
        } else if (this.recordingOwner !== guildUser.user.id) throw new BotCommandError("You can only stop your own recordings.");
        const reply = await message.reply("Stopping current recording...");
        await this.streamRecorder.stopRecording();
        const outFilePath = await this.streamRecorder.postProcess(this.optOuts);

        await this.reset();
        this.isRecording = false;
        this.recordingOwner = null;
        await this.setPresence();
    }
}

const setPermissionLevel = {
    name: "setperm",
    description: {
        short: "Set permission level of users and roles.",
        long: "Set permission level of mentioned users or roles. Defaults to `user` permission level. When checking a user's permission level, we first try to return that user's permission level. If that user has no defined permission level, we return the highest permission level of any role that user has.",
        example: "setperm @User#1234 @User2#5678 @role"
    },
    level: 2,
    options: {
        "--admin": {
            description: "Set `admin` permission level for mentioned roles and users.",
            level: 3,
        },
        "--guest": {
            description: "Set `guest` permission level for mentioned roles and users.",
            level: 2,
        },
        "--unset": {
            description: "Unset permissions for mentioned users and roles.",
            level: 2,
        },
        "--wipeusers": {
            description: "Remove all saved user permissions.",
            level: 3,
        },
        "--wiperoles": {
            description: "Remove all saved role permissions.",
            level: 3,
        }
    },
    mentions: {
        user: {
            description: "Any number of users."
        },
        role: {
            description: "Any number of roles. `@everyone` and `@here` do not count as roles."
        },
    },
    // FIXME: admins can unset other admins.
    exec: async function (messageContext, commandOptions) {
        const {message, guild} = messageContext;
        const guildId = guild.id;
        this.permissions[guildId] = this.permissions[guildId] || {members: {}, roles: {}};
        let levelToSet = 1;
        if (commandOptions.includes("--wipeusers")) this.permissions[guildId].members = {};
        if (commandOptions.includes("--wiperoles")) this.permissions[guildId].roles = {};
        if (commandOptions.includes("--admin") && commandOptions.includes("--guest")) {
            await message.react("❓");
            return;
        } else if (commandOptions.includes("--admin")) levelToSet = 2;
        else if (commandOptions.includes("--guest")) levelToSet = 0;

        message.mentions.users.map(u => u.id).forEach(id => {
            this.permissions[guildId].members[id] = levelToSet;
            if (commandOptions.includes("--unset")) delete this.permissions[guildId].members[id];
        });
        message.mentions.roles.map(r => r.id).forEach(id => {
            this.permissions[guildId].roles[id] = levelToSet
            if (commandOptions.includes("--unset")) delete this.permissions[guildId].roles[id];
        });
        this.saveConfigToFile();
        await message.react("✅");
    }
}

const listPermissionLevels = {
    name: "listperms",
    description: {
        short: "List permission level of users and roles.",
        long: "List permission level of mentioned users and roles. If no users or roles were mentioned, list all permissions. This command will create pings, use it in an admin channel.",
        example: "listperms `@User#1234`"
    },
    level: 2,
    mentions: {
        user: {
            description: "Any number of users."
        },
        role: {
            description: "Any number of roles. `@everyone` and `@here` do not count as roles."
        },
    },
    // FIXME: If the reply is longer than 2000 characters, we will get an api error.
    exec: async function (messageContext, commandOptions) {
        const {message, guild, guildUser, guildUserPermLevel} = messageContext;
        const guildId = guild.id;
        this.permissions[guildId] = this.permissions[guildId] || {members: {}, roles: {}};
        const lvlToStr = (lvl) => {
            if (lvl === 0) return "guest"
            if (lvl === 1) return "user"
            if (lvl === 2) return "admin"
            if (lvl === 3) return "owner"
        }
        try {
            if (message.mentions.users.size !== 0 || message.mentions.roles.size !== 0) {
                message.reply(`**Permissions**\n${message.mentions.users.map(m => m.id).filter(mid => this.permissions[guildId].members[mid]).map(mid => `<@${mid}>: ${lvlToStr(this.permissions[guildId].members[mid])}\n`).join("")}${message.mentions.roles.map(r => r.id).filter(rid => this.permissions[guildId].roles[rid]).map(rid => `<@&${rid}>: ${lvlToStr(this.permissions[guildId].roles[rid])}\n`).join("")}`);
            } else {
                const savedPerms = [...Object.entries(this.permissions[guildId].members).map(([k, v]) => [`<@${k}>`, v]),
                    ...Object.entries(this.permissions[guildId].roles).map(([k, v]) => [`<@&${k}>`, v]),
                ];
                message.reply(`**Saved Admins:**\n${savedPerms.filter(it => it[1] === 2).map(it => it[0]).join("") || "\u2014"}`);
                message.reply(`**Saved Users:**\n${savedPerms.filter(it => it[1] === 1).map(it => it[0]).join("") || "\u2014"}`);
                message.reply(`**Saved Guests:**\n${savedPerms.filter(it => it[1] === 0).map(it => it[0]).join("") || "\u2014"}`);
            }
        } catch (e) {
            console.log(e);
            throw new BotCommandError(`:Clueless: surely we didn't just try to send a message with >2000 characters.`);
        }
    }
}

const optOut = {
    name: "optout",
    description: {
        short: "Opt out of recordings.",
        long: "Opt out of recordings. When you opt out of recordings, the bot does not record your voice or streams. You can opt out of running recordings. Use the `optin` command to allow the bot to record you again.",
        example: "optout"
    },
    level: 0,
    exec: async function (messageContext, commandOptions) {
        const {message, guildUser} = messageContext;
        const userId = guildUser.user.id;
        this.optOuts.add(userId);
        await message.react("🆗");
        this.saveConfigToFile();
    }
}

const optIn = {
    name: "optin",
    description: {
        short: "Opt back into recordings.",
        long: "",
        example: "optin"
    },
    level: 0,
    exec: async function (messageContext, commandOptions) {
        const {message, guildUser} = messageContext;
        const userId = guildUser.user.id;
        this.optOuts.delete(userId);
        await message.react("🆗");
        this.saveConfigToFile();
    }
}

const recordingInfo = {
    name: "info",
    description: {
        short: "Display info about the current recording.",
        long: "Display info about the current recording.",
        example: "info"
    },
    level: 1,
    exec: async function (messageContext, commandOptions) {
        const {message, guild, guildUser, guildUserPermLevel} = messageContext;
        if (!this.isRecording) {
            message.reply("Currently not recording.");
            return;
        }
        const timeStr = `Recording for ${calcTimeDiff(this.streamRecorder.timeStamp, Date.now())} (hours:minutes:seconds)`;

        message.reply(`${timeStr}`);
    }
}

const setPrefix = {
    name: "setprefix",
    description: {
        short: "Set the command prefix.",
        long: "Set the command prefix.",
        example: "setprefix ."
    },
    level: 3,
    exec: async function (messageContext, commandOptions) {
        const {message, guild, guildUser, guildUserPermLevel} = messageContext;
        const messageContent = message.content;
        const newPrefix = messageContent.replace(new RegExp(`^${this.prefix.replace(/[-/\\^$*+?.()|[\]{}]/g, "\\$&")}setprefix`), "").trim();
        await message.reply(`You are about to update the command prefix to \`${newPrefix.replace(/`/g, "\`")}\`. Are you sure? Please confirm with \`${newPrefix.replace(/`/g, "\`")}confirm\`.`);
        const listener = async (confirmMessageHopefully) => {
            if (confirmMessageHopefully.guildId !== guild.id) return;
            if (confirmMessageHopefully.channelId !== message.channel.id) return;
            if (confirmMessageHopefully.author.id !== guildUser.user.id) return;
            if (confirmMessageHopefully.content.trim() !== `${newPrefix}confirm`) return;
            clearTimeout(timeout);
            this.prefix = newPrefix;
            this.saveConfigToFile();
            confirmMessageHopefully.reply("Success!");
            this.setPresence();
        }
        const timeout = setTimeout(() => {
            message.channel.send("Timed out setting prefix.");
            this._client.off("messageCreate", listener);
        }, 60000);
        this._client.on("messageCreate", listener);
    }
}

const reset = {
    name: "reset",
    description: {
        short: "Reset the bot.",
        long: "Reset the bot.",
        example: "reset"
    },
    level: 2,
    exec: async function (messageContext, commandOptions) {
        messageContext.message.reply("Resetting...");
        await this.reset();
    }
}

module.exports = {
    startRecording,
    stopRecording,
    setPermissionLevel,
    listPermissionLevels,
    optOut,
    optIn,
    recordingInfo,
    setPrefix,
    reset,
    BotCommandError,
}
