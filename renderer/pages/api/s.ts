import { NextApiResponseServerIO } from "@/types/next";
import axios from "axios";
import checkDiskSpace from "check-disk-space";
import { exec, spawn } from "child_process";
import { app, dialog, shell } from "electron";
import fs from "fs";
import { Server as NetServer } from "http";
import { NextApiRequest } from "next";
import os from "os";
import { Server as ServerIO } from "socket.io";

const homeDir = app.getPath("home");

export const config = {
  api: {
    bodyParser: false,
  },
};

export let program: import("child_process").ChildProcessWithoutNullStreams =
  null as any;

const deviceisWindows = process.platform === "win32";

const DEFAULT_MODEL_LOCATION = homeDir + "/FreedomGPT";

const CHAT_APP_LOCATION = app.isPackaged
  ? process.resourcesPath + "/models/llama/main"
  : deviceisWindows
  ? process.cwd() + "/llama.cpp/build/bin/Release/main"
  : process.cwd() + "/llama.cpp/main";

const SocketHandler = (req: NextApiRequest, res: NextApiResponseServerIO) => {
  if (!res.socket.server.io) {
    const httpServer: NetServer = res.socket.server as any;
    const io = new ServerIO(httpServer, {
      path: "/api/socketio",
    });

    res.socket.server.io = io;

    io.on("connection", (socket) => {
      const totalRAM = os.totalmem() / 1024 ** 3;
      const freeRAM = os.freemem() / 1024 ** 3;
      const usedRAM = totalRAM - freeRAM;

      socket.emit("ram_usage", {
        totalRAM: totalRAM.toFixed(2),
        freeRAM: freeRAM.toFixed(2),
        usedRAM: usedRAM.toFixed(2),
      });

      socket.on("open_github", () => {
        shell.openExternal("https://github.com/ohmplatform/FreedomGPT", {
          activate: true,
        });
      });

      socket.on("open_discord", () => {
        shell.openExternal("https://discord.com/invite/h77wvJS4ga", {
          activate: true,
        });
      });

      socket.on("open_donation", () => {
        shell.openExternal("https://app.freedomgpt.com/donation", {
          activate: true,
        });
      });

      socket.on("open_link", (link) => {
        shell.openExternal(link, {
          activate: true,
        });
      });

      if (deviceisWindows) {
        checkDiskSpace("C:/")
          .then((diskSpace) => {
            socket.emit("disk_usage", {
              totalDisk: (diskSpace.size / 1024 ** 3).toFixed(2),
              freeDisk: (diskSpace.free / 1024 ** 3).toFixed(2),
            });
          })
          .catch((err) => {
            console.error(err);
          });
      } else {
        checkDiskSpace("/")
          .then((diskSpace) => {
            socket.emit("disk_usage", {
              totalDisk: (diskSpace.size / 1024 ** 3).toFixed(2),
              freeDisk: (diskSpace.free / 1024 ** 3).toFixed(2),
            });
          })
          .catch((err) => {
            console.error(err);
          });
      }

      let selectedModel: string = "";

      socket.on("delete_model", (data) => {
        fs.unlink(data, (err) => {
          if (err) {
            console.error(err);
            return;
          }
        });
      });

      // socket.emit("selected_model", selectedModel);

      socket.on("choose_model", (data) => {
        selectedModel = data.model;
        const options = {
          defaultPath: DEFAULT_MODEL_LOCATION,
          buttonLabel: "Choose",

          filters: [
            {
              name: "Model",
              extensions: ["bin", "gguf", "ggml"],
            },
          ],
        };

        dialog.showOpenDialog(options).then((result) => {
          if (!result.canceled) {
            const filePath = result.filePaths[0];

            socket.emit("download_complete", {
              downloadPath: filePath,
              modelData: data,
            });
          }
        });
      });

      socket.on("download_model", (data) => {
        const selectedModel = data.model;
        const fileName = data.downloadURL.split("/").pop();
        const filePath = DEFAULT_MODEL_LOCATION + "/" + fileName;

        if (fs.existsSync(filePath)) {
          fs.rmSync(filePath);
        }

        const options = {
          defaultPath: filePath,
          buttonLabel: "Download",
        };
        let downloadPath: string = "" as string;
        let writer: fs.WriteStream = null as any;
        let lastPercentage = 0;

        const cancelDownload = () => {
          writer.close();
          fs.unlinkSync(downloadPath);
          socket.emit("download_canceled");
        };

        dialog.showSaveDialog(options).then((result) => {
          if (result.canceled) {
            socket.emit("download_canceled");
            console.log("Cancelled download");
          }
          if (!result.canceled) {
            downloadPath = result.filePath as string;
            writer = fs.createWriteStream(downloadPath);
            socket.emit("download_begin");

            axios({
              url: data.downloadURL,
              method: "GET",
              responseType: "stream",
            })
              .then((response) => {
                const contentLength = response.headers["content-length"];
                response.data.pipe(writer);

                socket.emit("download_started", {
                  contentLength,
                  selectedModel,
                });

                let downloadedBytes = 0;

                response.data.on("data", (chunk: any) => {
                  downloadedBytes += chunk.length;
                  const percentage = Math.floor(
                    (downloadedBytes / Number(contentLength)) * 100
                  );

                  if (percentage > lastPercentage) {
                    lastPercentage = percentage;
                    socket.emit("download_progress", {
                      percentage,
                      downloadedBytes,
                      contentLength,
                      selectedModel,
                    });
                  }
                });

                writer.on("finish", () => {
                  console.log(`\nModel downloaded to ${downloadPath}`);

                  socket.emit("download_complete", {
                    downloadPath,
                    modelData: data,
                  });
                });

                writer.on("error", (err) => {
                  console.error("Failed to download model:", err);
                });
              })
              .catch((error) => {
                console.error("Failed to download model:", error);
                if (fs.existsSync(downloadPath)) {
                  fs.unlinkSync(downloadPath);
                }

                socket.emit("download_model", data);
              });
          }
        });

        socket.on("cancel_download", () => {
          cancelDownload();
        });
      });

      socket.on(
        "select_model",
        (data: {
          model: string;
          FILEPATH: string;
          extraArgs: {
            [key: string]: string;
          };
        }) => {
          console.log(data);
          selectedModel = data.model;
          const FILEPATH = `${data.FILEPATH}`;
          const extraArgs = data.extraArgs;

          if (program) {
            program.kill();
          }

          program = spawn(CHAT_APP_LOCATION, [
            "-m",
            FILEPATH,
            "-ins",
            "-t",
            extraArgs.t ? extraArgs.t : "5",
          ]);

          program.on("error", (err) => {
            console.error("Failed to start child process:", err);
          });

          program.stdout.on("error", (err) => {
            console.error("Failed to start child process:", err);
          });

          program.stdout.on("readable", () => {
            socket.emit("model_loading", false);
            socket.emit("model_loaded", true);
            socket.emit("selected_model", selectedModel);

            let data = program.stdout.read();

            if (data) {
              const dataString = data.toString("utf8");
              socket.emit("response", dataString);
            } else {
              console.log("No data");
            }
          });

          program.stdout.on("pause", () => {
            console.log("pausing");
          });

          program.stderr.on("data", (data) => {
            console.log(data.toString("utf8") + "123");
          });

          program.on("exit", (code, signal) => {
            console.log(
              `Child process exited with code ${code} and signal ${signal}`
            );
          });

          program.on("spawn", () => {
            socket.emit("model_loading", true);
          });
        }
      );

      socket.on("message", (message) => {
        if (program && program.stdin) {
          program.stdin.write(message + "\n");
        }
      });

      socket.on("stopResponding", () => {
        if (program) {
          program.kill("SIGINT");
        }
      });

      socket.on("disconnect", (reason) => {
        if (program) {
          program.kill();
          program = null as any;
        }
        console.log(`Socket disconnected: ${reason}`);
      });

      socket.on("kill_process", () => {
        if (program) {
          program.kill();
          program = null as any;
        }
      });
    });
  }

  res.end();
};

export default SocketHandler;