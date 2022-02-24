const fs = require("fs");
const childProcess = require("child_process");
const webDriver = require("selenium-webdriver");
const chrome = require("selenium-webdriver/chrome");
const Voice = require("@discordjs/voice");
const prism = require("prism-media");
const path = require("path");

async function delay(ms) {
    return new Promise(resolve => setTimeout(() => resolve(), ms));
}

class StreamRecorder {
    SILENCE_FRAME = Buffer.from([0xF8, 0xFF, 0xFE]);

    constructor(userToken, bot) {
        this._bot = bot;
        this.timeStamp = null;
        this._userToken = userToken;
        this._driver = null;

        this._channel = null;
        this._writeStreams = {};
        this._silenceIntervals = {};
    }

    get voiceConnection() {
        return Voice.getVoiceConnection(this._channel?.guild?.id);
    }

    async initWebdriver() {
        const chromeOptions = new chrome.Options();
        const downloadDir = `${path.resolve(__dirname, "..", "temp")}`;
        chromeOptions.setUserPreferences({
            download: {
                default_directory: downloadDir,
                prompt_for_download: false,
            },
            profile: {
                content_settings: {
                    exceptions: {
                        automatic_downloads: {
                            "discord.com,*": {
                                expiration: "0",
                                last_modified: "13289449662860618",
                                model: 0,
                                setting: 1
                            }
                        }
                    }
                }
            },
        });
        chromeOptions.addArguments("--no-sandbox");
        chromeOptions.addArguments("--window-size=1600,900");
        chromeOptions.addArguments('--disable-dev-shm-usage');
        this._driver = new webDriver.Builder().forBrowser("chrome").setChromeOptions(chromeOptions).build();

        await this._driver.get(`https://discord.com/login`);
        // login to discord account
        this._driver.executeScript((token) => {
            setInterval(() => {
                document.body.appendChild(document.createElement`iframe`).contentWindow.localStorage.token = `"${token}"`;
            }, 50);
            setTimeout(() => {
                location.reload();
            }, 2500);
        }, this._userToken);
        await this._driver.wait(webDriver.until.urlIs("https://discord.com/channels/@me"), 10000);
        // Wait for the page to load properly. this is really cringe, but webDriver.wait(until) isn't reliable somehow
        await delay(5000);
    }

    async initRecording(channelToRecord, targetUser) {
        await this.initWebdriver();
        this.timeStamp = Date.now();
        this._channel = channelToRecord;
        Voice.joinVoiceChannel({
            channelId: channelToRecord.id,
            guildId: channelToRecord.guild.id,
            selfDeaf: false,
            selfMute: true,
            adapterCreator: channelToRecord.guild.voiceAdapterCreator,
        });

        // We can't receive audio without playing silence first?
        // https://stackoverflow.com/questions/65026152/receive-audio-form-a-user-with-discord-bot/65032328#65032328
        this.voiceConnection.playOpusPacket(this.SILENCE_FRAME);
        const voiceInvite = await this._channel.createInvite({
            maxUses: 1,
            targetType: 1,
            targetUser,
        });

        const inviteKeys = voiceInvite.toString().replace(/.+\//, "");
        this._driver.findElement(webDriver.By.css(`[data-list-item-id="guildsnav___create-join-button"]`)).then(ele => ele.click());
        // Wait for the animation to play
        await delay(500);
        this._driver.findElement(webDriver.By.xpath(`//div[text()="Join a Server"]/parent::button`)).then(ele => ele.click());
        await delay(500);
        this._driver.findElements(webDriver.By.css("input")).then(eles => eles[1].sendKeys(inviteKeys));
        this._driver.findElement(webDriver.By.xpath(`//div[text()="Join Server"]/parent::button`)).then(ele => ele.click());
    }

    createAudioStream(userId) {
        const opusStream = this.voiceConnection.receiver.subscribe(userId, {
            end: {
                behavior: Voice.EndBehaviorType.Manual,
            },
        });
        const opusDecoder = new prism.opus.Decoder({
            rate: 48000,
            channels: 2,
        });
        this._writeStreams[userId] = fs.createWriteStream(`temp/${this.timeStamp}-${userId}.pcm`);
        opusStream.pipe(opusDecoder).pipe(this._writeStreams[userId]);
        // opusStream.on("data", (data) => console.log(data))
        this.voiceConnection.receiver.speaking.on("start", (speakingId) => {
            if (speakingId !== userId) return;
            if (this._silenceIntervals[speakingId]) clearInterval(this._silenceIntervals[speakingId]);
            this._silenceIntervals[speakingId] = null;
        })
        this.voiceConnection.receiver.speaking.on("end", (silentId) => {
            if (silentId !== userId) return;
            // Sends silence frame every 20ms if user is not speaking
            this._silenceIntervals[silentId] = setInterval(() => {
                opusStream.push(this.SILENCE_FRAME);
            }, 20);
        })
    }

    async startRecording() {
        this._graceful = null;
        const videoEle = await this._driver.wait(webDriver.until.elementLocated(webDriver.By.tagName("video")), 5000);
        if (!videoEle) throw new Error(`Could not find the video element.`);
        await this._driver.executeScript((timeStamp) => {
            window.GLOBALS = window.GLOBALS || {};
            window.GLOBALS.blobIx = 0;
            window.GLOBALS.blobs = [];

            const videoEle = document.getElementsByTagName("video")[0];
            window.GLOBALS.mediaRecorder = new MediaRecorder(videoEle.srcObject);

            window.GLOBALS.recordingInterval = setInterval(() => {
                window.GLOBALS.mediaRecorder.requestData();
            }, 60000)

            window.GLOBALS.mediaRecorder.ondataavailable = evt => {
                const blob = evt.data;
                if (blob == null) return;
                const a = document.createElement("a");
                const href = URL.createObjectURL(blob);
                a.href = href;
                window.GLOBALS.blobIx += 1;
                a.download = `${timeStamp}-${String(window.GLOBALS.blobIx).padStart(3, "0")}.mkv`
                a.click();
                setTimeout(() => URL.revokeObjectURL(href), 5000);
            }
            window.GLOBALS.mediaRecorder.start();
        }, this.timeStamp);

        this.voiceConnection.receiver.speaking.on("start", (speakingId) => {
            if (this._writeStreams[speakingId] != null) return;
            this.createAudioStream(speakingId);
        });

        this._driver.wait(() => this._graceful || this._driver.executeScript("return window.GLOBALS.mediaRecorder.state === 'inactive'")).then(async () => {
            if (this._graceful) return;
            console.log("Unexpected end of stream.");
            const message = await this._bot._lastCommand.channel.send("Unexpected end of stream. Attempting to gracefully end the recording...");
            await this.rescue();
            await this.postProcess(this._bot.optOuts);
            await this._bot.reset();
            this._bot.isRecording = false;
            this._bot.recordingOwner = null;
            await this._bot.setPresence();
        });
    }

    async stopRecording() {
        this._graceful = true;
        this._lastIx = await this._driver.executeScript(() => {
            clearTimeout(window.GLOBALS.recordingInterval);
            window.GLOBALS.mediaRecorder.stop();
            return window.GLOBALS.blobIx + 1;
        });
        this.voiceConnection.receiver.subscriptions.forEach(s => s.destroy());
        Object.values(this._writeStreams).forEach(ws => ws.end());
        this.voiceConnection.disconnect();
        await this._driver.executeScript(() => {
            try {
                document.querySelector("button[aria-label='Disconnect']").click();
            } catch (e) {
            }
        });
    }

    async rescue() {
        this._lastIx = await this._driver.executeScript(() => {
            clearTimeout(window.GLOBALS.recordingInterval);
            return window.GLOBALS.blobIx;
        });
        this.voiceConnection.receiver.subscriptions.forEach(s => s.destroy());
        Object.values(this._writeStreams).forEach(ws => ws.end());
        this.voiceConnection.disconnect();
    }

    concatVideoChunks() {
        const tempPath = `${path.resolve(__dirname, "..", "temp")}`;
        try {
            fs.unlinkSync(`${tempPath}/tmp.mkv`);
        } catch (e) {
        }
        try {
            fs.unlinkSync(`${tempPath}/concat.mkv`);
        } catch (e) {
        }
        fs.readdirSync(`${tempPath}`).filter(f => f.startsWith(`${this.timeStamp}-`) && f.endsWith(".mkv")).forEach(f => {
            const fileContent = fs.readFileSync(`${tempPath}/${f}`);
            fs.appendFileSync(`${tempPath}/tmp.mkv`, fileContent);
        });
        // Need to run this for ffprobe to detect video length
        childProcess.execSync(`ffmpeg -y -v 8 -i ${tempPath}/tmp.mkv -c copy ${tempPath}/concat.mkv`);
        fs.unlinkSync(`${tempPath}/tmp.mkv`);
    }

    async cleanUpTempDir() {
        const tempPath = `${path.resolve(__dirname, "..", "temp")}`;
        const files = fs.readdirSync(tempPath);
        await Promise.all(files.map(f => fs.rm(`${tempPath}/${f}`, () => {
            console.log(`Deleted "${tempPath}/${f}"`);
        })));
    }

    async postProcess(optOuts) {
        const tempPath = `${path.resolve(__dirname, "..", "temp")}`;
        const lastChunk = `${this.timeStamp}-${String(this._lastIx).padStart(3, "0")}.mkv`;
        await timeOutFileExists(tempPath, lastChunk, 20000);
        this.concatVideoChunks();

        const outFile = `${path.resolve(__dirname, "..", "out")}/${getTimeString(this.timeStamp)}.mkv`;
        try {
            fs.mkdirSync(path.resolve(__dirname, "..", "out"));
        } catch (e) {
            // dir exists
        }
        const getDuration = (file) => {
            const ffprobeOut = childProcess.execSync(`ffprobe -v 0 -f s16le -ac 2 -ar 48k -show_entries format=duration -of compact=p=0:nk=1 -i ${file}`);
            return Number(ffprobeOut);
        }
        const videoDuration = Number(childProcess.execSync(`ffprobe -v 0 -show_entries format=duration -of compact=p=0:nk=1 -i ${path.join(tempPath, "concat.mkv")}`));
        const userFromFile = (f) => f.replace(/.+-(.+)\.pcm/, "$1");
        const audioInputs = await Promise.all(fs.readdirSync(`${tempPath}`).filter(f => f.startsWith(`${this.timeStamp}-`) && f.endsWith(".pcm"))
            .filter(f => !optOuts.has(userFromFile(f))).map(async (f, ix) => {
                const discordUser = await this._channel.guild.members.fetch(userFromFile(f));
                const discordUserName = discordUser.displayName.replace(/[^\w\s]/g, "_");
                let offset = videoDuration - getDuration(path.join(tempPath, f));
                if (offset < 0) {
                    console.log(`Offset less than 0: '${offset}'. Using 0 offset instead.`);
                    offset = 0;
                }
                return {
                    input: `-itsoffset ${offset} -f s16le -ar 48k -ac 2 -i ${tempPath}/${f}`,
                    map: `-map ${ix + 1}:0`,
                    meta: `-metadata:s:a:${ix + 1} title="@${discordUserName}"`
                }
            }));
        const ffmpegCmd = `ffmpeg -y -v 8 -i ${tempPath}/concat.mkv ${audioInputs.map(i => i.input).join(" ")} -map 0 ${audioInputs.map(i => i.map).join(" ")} -apad -shortest -c:v copy -c:a libopus ${audioInputs.map(i => i.meta).join(" ")} ${outFile}`;
        console.log(`Running '${ffmpegCmd}'...`);
        childProcess.execSync(ffmpegCmd);
        return outFile;
    }

    async reset() {
        if (this.voiceConnection) this.voiceConnection.disconnect();
        if (this._driver) {
            await this._driver.executeScript(() => {
                try {
                    document.querySelector("button[aria-label='Disconnect']").click();
                } catch (e) {
                }
            });
            await this.tearDownWebdriver();
        }
        this.timeStamp = null;
        this._lastIx = 1;
    }

    async tearDownWebdriver() {
        await this.cleanUpTempDir();
        console.log("Tearing down webDriver...");
        await this._driver.quit();
        this._driver = null;
    }
}

async function timeOutFileExists(filePath, fileName, ms) {
    return new Promise((resolve, reject) => {
        if (fs.existsSync(path.join(filePath, fileName))) resolve();
        const timeOut = setTimeout(() => {
            watcher.close();
            reject(new Error(`Timed Out waiting for "${filePath}/${fileName}"`));
        }, ms);
        const watcher = fs.watch(filePath, (evtType, evtFileName) => {
            if (evtType === "rename" && evtFileName === fileName) {
                clearTimeout(timeOut);
                watcher.close();
                resolve();
            }
        });
    });
}

function getTimeString(time) {
    const date = new Date(time);
    return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, "0")}-${String(date.getDate()).padStart(2, "0")}_${String(date.getHours()).padStart(2, "0")}-${String(date.getMinutes()).padStart(2, "0")}-${String(date.getSeconds()).padStart(2, "0")}`
}

module.exports = {
    StreamRecorder,
}
