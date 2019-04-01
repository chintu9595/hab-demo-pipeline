"use strict";

var AWS = require("aws-sdk");
var querystring = require("querystring"); // for user parameters

exports.handler = function(event, context) {
    var ssm = new AWS.SSM();
    var codepipeline = new AWS.CodePipeline();

    //console.log(JSON.stringify(event));
    var cmds = [];
    var userParams = querystring.parse(event["CodePipeline.job"].data.actionConfiguration.configuration.UserParameters);
    var pkgOrigin = "$(awk -F= '/^pkg_origin/{print $2}' /tmp/SourceOutput/plan.sh)";
    var pkgName = "$(awk -F= '/^pkg_name/{print $2}' /tmp/SourceOutput/plan.sh)";
    var pkgIdent = pkgOrigin + "/" + pkgName;
    console.log(userParams.githubToken);
    console.log(pkgOrigin);
    console.log("see");
    console.log(userParams);
    switch (userParams.command) {
        case "Stage-SourceCode":
            var s3Location = event["CodePipeline.job"]["data"]["inputArtifacts"][0]["location"]["s3Location"];
            cmds.push("aws configure set s3.signature_version s3v4");
            cmds.push("aws s3 cp s3://" + s3Location.bucketName + "/" + s3Location.objectKey + " /tmp/SourceOutput.zip");
            cmds.push("rm -rf /tmp/SourceOutput && mkdir /tmp/SourceOutput && unzip /tmp/SourceOutput.zip -d /tmp/SourceOutput");
            break;
        case "Initialize-Habitat":
            cmds.push("export HAB_AUTH_TOKEN=" + userParams.habitattoken);
            cmds.push("export HAB_ORIGIN=" + pkgOrigin);
            cmds.push("hab origin key generate " + pkgOrigin);
            cmds.push("hab origin key upload " + pkgOrigin);
            break;
        case "Test-StaticAnalysis":
            cmds.push("bash -n /tmp/SourceOutput/plan.sh");
            //Disable shellcheck for now.  Takes too long to install on Amazon Linux
            //cmds.push("shellcheck -e SC2034 -e SC2154 /tmp/SourceOutput/plan.sh");
            break;
        case "Build-HabitatPackage":
            cmds.push("cd /tmp/SourceOutput && hab pkg build . && mkdir -p /tmp/pipeline/hab && cp -r /tmp/SourceOutput/results \"$_\"");
            break;
        case "Create-TestEnvironment":
            cmds.push("cd SourceOutput");
            cmds.push("export HAB_ORIGIN=" + pkgOrigin);
            cmds.push("purge_containers=$(if [ $(docker ps -a -q | wc -l) -gt 0 ]; then docker rm -f -v $(docker ps -a -q); fi)");
            cmds.push("purge_images=$(if [  $(docker images -q | wc -l) -gt 0 ]; then docker rmi -f $(docker images -q); fi)");
            cmds.push("hab studio run \"hab pkg export docker " + pkgIdent + "\"");
            cmds.push("docker run -it -d -p 8080:8080 --name " + pkgName + " " + pkgIdent);
            break;
        case "Test-HabitatPackage":
            cmds.push("bats --tap /tmp/SourceOutput/test.bats");
            break;
        case "Publish-HabitatPackage":
            var pkgArtifact = "$(awk -F= '/^pkg_artifact/{print $2}' /tmp/pipeline/hab/results/last_build.env)";
            cmds.push("cd /tmp/pipeline/hab/results");
            cmds.push("export HAB_AUTH_TOKEN=" + userParams.habitattoken);
            cmds.push("hab pkg upload " + pkgArtifact);
            break;
        default:
            putJobFailure("Invalid Command: " + userParams.command);
            return;
    }

    // Retrieve the Job ID from the Lambda action
    var jobId = event["CodePipeline.job"].id;

    // Notify AWS CodePipeline of a successful job
    var putJobSuccess = function(message) {
        var params = {
            jobId: jobId
        };
        codepipeline.putJobSuccessResult(params, function(err, data) {
            if (err) {
                context.fail(err);
            } else {
                context.succeed(message);
            }
        });
    };

    // Notify AWS CodePipeline of a failed job
    var putJobFailure = function(message) {
        var params = {
            jobId: jobId,
            failureDetails: {
                message: JSON.stringify(message),
                type: 'JobFailed',
                externalExecutionId: context.invokeid
            }
        };
        codepipeline.putJobFailureResult(params, function(err, data) {
            context.fail(message);
        });
    };

    var runCommand = function(cmds, instanceId, event, callback) {
        var params = {
            DocumentName: "AWS-RunShellScript",
            InstanceIds: [instanceId],
            Parameters: {
                commands: cmds,
                workingDirectory: ["/tmp"],
                executionTimeout: ["300"]
            },
            TimeoutSeconds: 300
        };
        console.log(JSON.stringify(params));
        ssm.sendCommand(params, function(err, data) {
            if (err) {
                callback(err);
            } else {
                var timer = setInterval(function() {
                    console.log("filtering for CommandId: " + data.Command.CommandId);
                    ssm.listCommandInvocations({
                        CommandId: data.Command.CommandId
                    }, function(err, data2) {
                        console.log("checking command status...");
                        if (err) {
                            callback(err);
                        } else {
                            console.log("SSM Command status: " + JSON.stringify(data2));
                            var invoc = data2.CommandInvocations[0];
                            switch (invoc.Status) {
                                case "Success":
                                    clearInterval(timer);
                                    callback(null, data);
                                    break;
                                case "Failed":
                                    clearInterval(timer);
                                    callback("SSM Failed: " + invoc.TraceOutput);
                                    break;
                                case "Cancelled":
                                    clearInterval(timer);
                                    callback("SSM Cancelled: " + invoc.TraceOutput);
                                    break;
                                case "TimedOut":
                                    clearInterval(timer);
                                    callback("SSM TimedOut: " + invoc.TraceOutput);
                                    break;
                                default:
                                    console.log("SSM Command: " + data2.CommandInvocations[0].CommandId + " is in progress...");
                            }
                        }
                    });
                }, 2000);
            }
        });
    };


    runCommand(cmds, userParams.instanceId, event, function(err, data) {
        if (err) {
            console.log(err, err.stack);
            putJobFailure(err);
        } else {
            console.log(data);
            putJobSuccess("success");
        }
    });
};
