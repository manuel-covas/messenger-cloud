const fs = require("fs");
const readline = require("readline");
const rl = readline.createInterface(process.stdin, process.stdout);
const crypto = require('crypto');

const login = require("facebook-chat-api");
const https = require("https");

const maxSegmentSize = 23000000;

const syntax = "Usage:\n"+
               "    put <path>\n"+
               "    get <filename>";
const putSyntax = "Usage: put <path>";
const getSyntax = "Usage: get <filename>";

var loginOptions = {
    forceLogin: true
}

var apiOptions = {
    logLevel: "info",
    selfListen: true,
}


if (fs.existsSync("appState.json")) {

    var appState = {};

    console.log("Loading session from 'appState.json'");
    appState = JSON.parse(fs.readFileSync("appState.json"));

    login({appState: appState}, loginOptions, handleLogin);

}else{

    var login_data = {
        email: "",
        password: ""
    };

    rl.question("Account email: ", (email) => {
        login_data.email = email;
        rl.question("Account password: ", (password) => {
            login_data.password = password;
            login(login_data, loginOptions, handleLogin);
        });
    });
}


var messenger_api;
var stopListening;
var selfID;

function handleLogin(err, api) {
    if (err) {
        switch (err.error) {
            case 'login-approval':
                rl.question("Enter 2FA code > ", (code) => {
                    err.continue(code);
                });
            return;
            default:
                console.error(err);
        }
    }

    messenger_api = api;
    console.log("Logged in.");

    fs.writeFileSync("appState.json", JSON.stringify(messenger_api.getAppState(), null, 4));
    console.log("Saved session.");

    messenger_api.setOptions(apiOptions);
    selfID = messenger_api.getCurrentUserID();
    stopListening = messenger_api.listenMqtt(handleMessage);
    userInput();
}


function userInput() {
    rl.question("messenger-cloud > ", (input) => {

        var args = input.split(" ");

        if (args[0] == "put")
        {
            var args = input.split(" ");

            if (args.length < 2) {
                console.log(putSyntax);
                userInput();
                return;
            }
            
            var filePath = args[1];
            var splits = filePath.split("/");
            var fileName = splits[splits.length - 1];

            if (!fs.existsSync(filePath)) {
                console.log("Couldn't find "+filePath);
                userInput();
            }
            
            rl.question("File path: "+filePath+"\n"+
                        "File name: "+fileName+"\n"+
                        "Upload? ", (answer) => {
                            if (answer.toLowerCase().startsWith("y")) {
                                sendFile(filePath, fileName);
                            }else{
                                console.log("Aborting...");
                                userInput();
                            }
                        });

        }else if (args[0] == "get") {

            var args = input.split(" ");

            if (args.length < 2) {
                console.log(getSyntax);
                userInput();
                return;
            }

            findFile(args[1]);

        }else{
            console.log(syntax);
            userInput();
        }
    });
}




var messageCallbacks = {};

function handleMessage(err, event) {
    if(err) return console.error(err);

    switch(event.type) {

        case "message":
            if (event.threadID != selfID) {
                //console.log("Ignoring message on other thread '"+event.body+"'"); return;
            }

            var messageBody;
            try {
                messageBody = JSON.parse(event.body);
            } catch (error) {
                console.log("Ignoring message with invalid JSON '"+event.body+"'"); return;
            }
            
            
            messenger_api.markAsRead(event.threadID, (err) => {
                if(err) console.log(err);
            });

            if (messageCallbacks[messageBody.messageID] != undefined) {
                messageCallbacks[messageBody.messageID]();
            }

        break;

        default:
        break;
    }
}


function sendFile(filePath, fileName) {

    var fileBytes = fs.readFileSync(filePath);
    var fileLength = fileBytes.length;

    var segments = [];
    var fileOffset = 0;

    while (true) {
        
        var segmentSize = fileLength - fileOffset;

        if (segmentSize > maxSegmentSize) {
            segmentSize = maxSegmentSize;
        }

        segments.push(fileBytes.subarray(fileOffset, fileOffset + segmentSize));

        fileOffset += segmentSize;
        if (fileOffset == fileLength) break;
    }
    
    var uploadedSegments = 0;
    var uploadID = crypto.randomBytes(8).toString("hex");
    var index = 0;

    upload();

    function upload() {
        var segmentPath = "uploads/"+fileName+"-"+index+".bin";

        fs.writeFileSync(segmentPath, segments[index]);
        console.log("Uploading " + (index + 1) + "/" + segments.length + " - " + segmentPath);

        var messageID = crypto.randomBytes(8).toString("hex");
        var message = {
            body: JSON.stringify({
                messageID: messageID,
                uploadID: uploadID,
                fileName: fileName,
                segmentIndex: index,
                totalSegments: segments.length
            }, null, 4),
            attachment: fs.createReadStream(segmentPath)
        }
        messageCallbacks[messageID] = () => {
            uploadedSegments++;
            console.log("Uploaded segment "+(index + 1)+"/"+segments.length+". Erasing temporary file.");
            fs.unlinkSync(segmentPath);
            delete messageCallbacks[messageID];

            if (uploadedSegments == segments.length) {
                console.log("Done uploading file "+fileName+".");
                userInput();
            }else{
                index++;
                upload();
            }
        }
        messenger_api.sendMessage(message, selfID, (err, messageInfo) => {
            if (err) {
                console.error(err);
                console.log("Retrying...");
                upload();
            }
        });
    }
}


function findFile(wantedFileName) {
    messenger_api.getThreadHistory(selfID, 100, undefined, (err, history) => {
        if(err) return console.error(err);

        var uploads = {};

        history.forEach(message => {
            
            var messageBody;
            try {
                messageBody = JSON.parse(message.body);
            } catch (error) { return; }

            var messageID = messageBody.messageID;
            var uploadID = messageBody.uploadID;
            var fileName = messageBody.fileName;
            var timestamp = message.timestamp;
            var segmentIndex = messageBody.segmentIndex;
            var totalSegments = messageBody.totalSegments;

            if (messageID == undefined || uploadID == undefined || fileName == undefined || timestamp == undefined || segmentIndex == undefined || totalSegments == undefined)
                return;

            if (fileName == wantedFileName) {

                if (uploads[uploadID] == undefined) {
                    uploads[uploadID] = {
                        fileName: fileName,
                        timestamp: new Date(parseInt(timestamp)).toString(),
                        totalSegments: totalSegments,
                        segments: {}
                    }
                }

                uploads[uploadID].segments[segmentIndex] = new URL(message.attachments[0].url).searchParams.get("u");
            }
        });

        var uploadIDs = Object.keys(uploads);
        var candidateUploadIDs = [];

        uploadIDs.forEach((uploadID) => {
            var upload = uploads[uploadID];

            if (Object.keys(upload.segments).length == upload.totalSegments)
                candidateUploadIDs.push(uploadID);
        });

        if (candidateUploadIDs.length == 0) {
            console.log("No matches found.");
            userInput();
            return;
        }

        console.log("Matching uploads:");

        candidateUploadIDs.forEach((uploadID) => {

            var upload = uploads[uploadID];

            console.log("\n=== ID: "+uploadID+" ===\n"+
                          "Filename: "+upload.fileName+"\n"+
                          "Segment count: "+upload.totalSegments+"\n"+
                          "Upload date: "+upload.timestamp);
        });

        rl.question("\nSelect upload by ID > ", (selectedID) => {

            if (candidateUploadIDs.indexOf(selectedID) < 0) {
                console.log("ID not found, aborting...");
                userInput();
                return;
            }

            console.log("Starting...");
            downloadFile(uploads[selectedID]);
        });
    })
}


function downloadFile(upload) {

    var fileName = upload.fileName;
    var totalSegments = upload.totalSegments;
    var index = 0;

    fetchSegment();
    
    function fetchSegment() {

        console.log("Downloading segment "+(index + 1)+" / "+totalSegments);
        var segmentPath = "downloads/"+fileName+"-"+index+".bin";

        https.get(upload.segments[index], (response) => {

            var length = parseInt(response.headers["content-length"]);
            var data = "";

            printDownloadProgress(data.length, length);

            response.on("error", (err) => {
                console.error(err);
                console.log("Retrying failed download...");
                fetchSegment();
            });
            
            response.on("data", (chunk) => {
                data += chunk;
                printDownloadProgress(data.length, length);
            });

            response.on("end", () => {
                printDownloadProgress(data.length, length);
                fs.writeFileSync(segmentPath, data);
                console.log("\nDownloaded segment "+(index + 1));

                if (++index < upload.totalSegments) {
                    fetchSegment();
                }else{
                    console.log("Got all segments.");
                    assembleFile(upload);
                }
            });
        });
    }
}


function assembleFile(upload) {
    
    var outputPath = "downloads/"+upload.fileName;

    for (var index = 0; index < upload.totalSegments; index++) {

        var segmentPath = "downloads/"+upload.fileName+"-"+index+".bin";

        fs.appendFileSync(outputPath, fs.readFileSync(segmentPath));
        fs.unlinkSync(segmentPath);
    }

    console.log("Reassemled file to "+outputPath);
    userInput();
}


function printDownloadProgress(downloaded, total) {

    readline.clearLine(process.stdout, 0);
    readline.cursorTo(process.stdout, 0);

    if (total == undefined) {
        process.stdout.write("Downloaded: "+(downloaded / 1000000)+"MB.");
    }else{

        var fraction = downloaded / total;
        var roundedStep = Math.ceil(fraction * 20);

        var text = "Progress: " + (Math.round(fraction*100)) + "%  [";

        for (var i = 0; i < 20; i++) {
            if (i < roundedStep) {
                text += "#";
            }else{
                text += "=";
            }
        }

        text += "] "+(downloaded / 1000000)+"MB / "+(total / 1000000)+"MB";
        process.stdout.write(text);
    }
}
