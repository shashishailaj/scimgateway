//=================================================================================
// File:    scimgateway.js
//
// Author:  Jarle Elshaug
//
// Purpose: Started by endpoint plugin
//          Listens and replies on incoming SCIM requests
//          Communicates with plugin using event callback
//=================================================================================

'use strict';

var fs = require('fs');
var http = require('http');
var https = require('https');
var express = require('express');
var util = require('util');
var EventEmitter = require('events').EventEmitter;
var dot = require('dot-object');

/**
 * @constructor
 */
var ScimGateway = function (pluginName) {
    var configFile = __dirname + '/../config/' + pluginName + '.json'; // config name prefix same as pluging name prefix
    var config = require(configFile).scimgateway;
    var gwName = require('path').basename(__filename, '.js'); // prefix of current file 
    var dirLogs = __dirname + '/../logs';
    var log = require('../lib/logger')(config.loglevel, dirLogs + '/' + pluginName + '.log');
    var logger = log.logger;
    this.logger = logger;                           // exposed to plugin-code
    this.notValidAttributes = notValidAttributes;   // exposed to plugin-code

    // verify configuration file - scimgateway sub-elements
    if (!isValidconfig(config, ["localhostonly", "port", "username", "password", "loglevel"])) {
        logger.error(gwName + ' Configurationfile: ' + require.resolve(configFile));
        logger.error(gwName + ' Configurationfile have wrong or missing scimgateway sub-elements');
        logger.error(gwName + ' Stopping...');
        console.log();
        // process.exit(1) // may miss unflushed logger updates to logfile
        throw (new Error('Using exception to stop further asynchronous code execution (ensure synchronous logger flush to logfile and exit program), please ignore this one...'));
    }
    var pwCrypt = require("../lib/utils"); // getPasswords (empty=decryption failed, undefined=not found)
    var gwPassword = pwCrypt.getPassword('scimgateway.password', configFile);
    if (!gwPassword) {
        logger.error(gwName + ' Scimgateway password decryption failed');
        logger.error(gwName + ' Stopping...');
        console.log();
        // process.exit(1) // may miss unflushed logger updates to logfile
        throw (new Error('Using exception to stop further asynchronous code execution (ensure synchronous logger flush to logfile and exit program), please ignore this one...'));
    }
    if (!fs.existsSync(dirLogs)) {
        fs.mkdirSync(dirLogs);
    }
    var scimDef = require('../lib/scimdef');
    var errMsg = '';
    var app = express();
    var basicAuth = require('basic-auth');

    app.disable('etag'); // no etag header - disable local browser caching of headers - content type header changes will then be reflected
    app.disable('x-powered-by'); // no nodejs-express information in header
    app.use(function (req, res, next) { // authentication & content type
        var user = basicAuth(req)
        if (!user || user.name !== config.username || user.pass !== gwPassword) {
            if (user) logger.error(gwName + ' authentication failed for user "' + user.name + '"');
            res.setHeader('WWW-Authenticate', 'Basic realm="ScimGateway"');
            res.status(401).end('Access denied');
        } else {
            res.setHeader('Content-Type', 'application/json; charset=utf-8');
            return next();
        }
    });
    app.use(require('morgan')('combined', { "stream": log.stream }));   // express logging to log.stream (combined/common) instead of: app.use(express.logger('dev'));  /* 'default', 'short', 'tiny', 'dev' */


    // Initial connection, step #1: GET /ServiceProviderConfigs
    // If not included => Provisioning will always use GET /Users without any paramenters
    app.get('(|/v1)/ServiceProviderConfigs', function (req, res) {
        var tx = scimDef.ServiceProviderConfigs; // obfuscator friendly
        res.send(tx);
        logger.debug(gwName + ' GET = ' + req.originalUrl + ' Response = ' + JSON.stringify(tx));
    });


    // Initial connection, step #2: GET /Schemas
    app.get('(|/v1)/Schemas', function (req, res) {
        var tx = scimDef.Schemas;
        res.send(tx);
        logger.debug(gwName + ' GET = ' + req.originalUrl + ' Response = ' + JSON.stringify(tx));
    });


    app.get('(|/v1)/Users', (req, res) => {
        if (req.query.attributes === 'userName' && !req.query.filter) {
            //==========================================
            //             EXPLORE USERS
            //==========================================
            //
            // GET /Users?attributes=userName&startIndex=1&count=100
            //
            logger.debug(gwName + ' [Explore users]');
            var scimdata = new scimDef.scimResource();
            logger.debug(gwName + ' emitting event "explore-users" and awaiting result');
            this.emit('explore-users', req.query.startIndex, req.query.count, function (err, data) {
                if (err) {
                    logger.error(gwName + '[' + pluginName + '] ' + err.message);
                    res.status(500).send(gwName + '[' + pluginName + '] ' + err.message);
                }
                else {
                    if (data) scimdata = data;
                    res.send(scimdata);
                    logger.debug(gwName + '[' + pluginName + '] GET = ' + req.originalUrl + ' Response = ' + JSON.stringify(scimdata));
                }
            });


        } else if (req.query.filter) {
            //==========================================
            //             GET USER
            //==========================================
            //
            // GET /Users?filter=userName eq "bjensen"&attributes=ims,locale,name.givenName,externalId,preferredLanguage,userType,id,title,timezone,name.middleName,name.familyName,nickName,name.formatted,meta.location,userName,name.honorificSuffix,meta.version,meta.lastModified,meta.created,name.honorificPrefix,emails,phoneNumbers,photos,x509Certificates.value,profileUrl,roles,active,addresses,displayName,entitlements
            //
            // Get user request before/after updating a user:
            // GET = /Users?filter=userName eq "jsmith"&attributes=id,userName
            //
            //Get user request for retreving all attributes:
            //GET = /Users?filter=userName eq "jsmith"&attributes=ims,locale,name.givenName,externalId,preferredLanguage,userType,id,title,timezone,name.middleName,name.familyName,nickName,name.formatted,meta.location,userName,name.honorificSuffix,meta.version,meta.lastModified,meta.created,name.honorificPrefix,emails,phoneNumbers,photos,x509Certificates.value,profileUrl,roles,active,addresses,displayName,entitlements
            //
            // Get user from group:
            // GET = /Users?filter=id eq "jsmith"&attributes=id,userName
            // 
            var arrFilter = req.query.filter.split(" "); // userName eq "bjensen"
            if (arrFilter.length === 3) {
                if ((arrFilter[0] === 'userName' || arrFilter[0] === 'id') && arrFilter[1] === 'eq') {
                    var userName = arrFilter[2].replace(/"/g, ''); // bjensen
                    logger.debug(gwName + ' [Get User] userName=' + userName);
                    var scimdata = new scimDef.scimResource();
                    logger.debug(gwName + ' emitting event "get-user" and awaiting result');
                    this.emit('get-user', userName, req.query.attributes, function (err, data) {
                        if (err) {
                            logger.error(gwName + '[' + pluginName + '] ' + err.message);
                            res.status(500).send(gwName + '[' + pluginName + '] ' + err.message);
                        }
                        else {
                            if (data) scimdata.Resources.push(data);
                            scimdata = addPagination(scimdata);
                            res.send(scimdata);
                            logger.debug(gwName + '[' + pluginName + '] GET = ' + req.originalUrl + ' Response = ' + JSON.stringify(scimdata));
                        }
                    });
                } else {
                    errMsg = '"GET /Users?filter="<Incorrect filter definition>" must include userName (or id) and eq';
                    res.status(400).send('ScimGateway ' + gwName + ' ' + errMsg);
                    logger.error(gwName + ' GET = ' + req.originalUrl + ' Response = ' + errMsg);
                }
            } else {
                errMsg = '"GET /Users?filter="<Incorrect filter definition>"';
                res.status(400).send('ScimGateway ' + gwName + ' ' + errMsg);
                logger.error(gwName + ' GET = ' + req.originalUrl + ' Response = ' + errMsg);
            }

        } else {
            // GET /Users
            errMsg = '"GET /Users" not supported';
            res.status(400).send('ScimGateway ' + gwName + ' ' + errMsg);
            logger.error(gwName + ' GET = ' + req.originalUrl + ' Response = ' + errMsg);
        }
    });


    app.get('(|/v1)/Groups', (req, res) => {
        var scimdata = new scimDef.scimResource();
        if (req.query.attributes == 'displayName' && !req.query.filter) {
            //==========================================
            //             EXPLORE GROUPS
            //==========================================
            //
            // Explore: GET /Groups?attributes=displayName
            //
            logger.debug(gwName + ' [Explore Groups]');
            logger.debug(gwName + ' emitting event "explore-groups" and awaiting result');
            this.emit('explore-groups', req.query.startIndex, req.query.count, function (err, data) {
                if (err) {
                    logger.error(gwName + '[' + pluginName + '] ' + err.message);
                    res.status(500).send(gwName + '[' + pluginName + '] ' + err.message);
                }
                else {
                    if (data) scimdata = data;
                    scimdata = addPagination(scimdata);
                    res.send(scimdata);
                    logger.debug(gwName + '[' + pluginName + '] GET = ' + req.originalUrl + ' Response = ' + JSON.stringify(scimdata));
                }
            });
        }
        else {
            //==========================================
            //             Get group
            //             Get group members
            //==========================================
            //
            // Get group members:
            // GET = /Groups?filter=members.value eq "<user-id>"&attributes=members.value,displayName
            //
            // Get group:
            // GET /Groups?filter=displayName eq "Employees"&attributes=externalId,id,members.value,displayName

            var arrFilter = req.query.filter.split(" "); // members.value eq "bjensen"...
            if (arrFilter.length === 3) {
                if (arrFilter[0] === 'members.value' && arrFilter[1] === 'eq') {
                    //Get user groups
                    var userId = arrFilter[2].replace(/"/g, ''); // bjensen (id and not userName)
                    logger.debug(gwName + ' [Get Group Members] user id=' + userId);
                    logger.debug(gwName + ' emitting event "get-group-members" and awaiting result');
                    this.emit('get-group-members', userId, req.query.attributes, function (err, data) {
                        if (err) {
                            logger.error(gwName + '[' + pluginName + '] ' + err.message);
                            res.status(500).send(gwName + '[' + pluginName + '] ' + err.message);
                        }
                        else {
                            if (data) scimdata.Resources = data;
                            scimdata = addPagination(scimdata);
                            res.send(scimdata);
                            logger.debug(gwName + '[' + pluginName + '] GET = ' + req.originalUrl + ' Response = ' + JSON.stringify(scimdata));
                        }
                    });
                } // members.value (group members)
                else if (arrFilter[0] === 'displayName' && arrFilter[1] === 'eq') {
                    var groupDisplayname = arrFilter[2].replace(/"/g, ''); // Employees (displayName and not id)
                    logger.debug(gwName + ' [Get Group] group displayName=' + groupDisplayname);
                    logger.debug(gwName + ' emitting event "get-group" and awaiting result');
                    this.emit('get-group', groupDisplayname, req.query.attributes, function (err, data) {
                        if (err) {
                            logger.error(gwName + '[' + pluginName + '] ' + err.message);
                            res.status(500).send(gwName + '[' + pluginName + '] ' + err.message);
                        }
                        else {
                            if (data) scimdata.Resources.push(data);
                            scimdata = addPagination(scimdata);
                            res.send(scimdata);
                            logger.debug(gwName + '[' + pluginName + '] GET = ' + req.originalUrl + ' Response = ' + JSON.stringify(scimdata));
                        }
                    });
                } // displayName (group members)

            }
        }
    }); // app.get


    //==========================================
    //           CREATE USER
    //==========================================
    //
    // POST = /Users
    // Body contains user attributes including userName (userID)
    // Body example:
    // {"active":true,"name":{"familyName":"Elshaug","givenName":"Jarle"},"schemas":["urn:scim:schemas:core:1.0"],"userName":"elsja02"}
    //
    app.post('(|/v1)/Users', (req, res) => {
        logger.debug(gwName + ' [Create User]');
        var strBody = '';

        req.on('data', function (data) { //Get body
            strBody += data;
        });

        req.on('end', () => {
            var userObj = JSON.parse(strBody);
            if (userObj.schemas) delete userObj['schemas'];
            logger.debug(gwName + ' POST = ' + req.originalUrl + ' Body = ' + strBody);
            logger.debug(gwName + ' emitting event "create-user" and awaiting result');
            this.emit('create-user', userObj, function (err) {
                if (err) {
                    logger.error(gwName + ' ' + err.message);
                    res.status(500).send(gwName + '[' + pluginName + '] ' + err.message);
                }
                else {
                    res.status(204).send();
                    logger.debug(gwName + '[' + pluginName + '] PATCH = ' + req.originalUrl + ' Response = 204 (OK and no content)');
                }
            });

        });
    }); //put


    //==========================================
    //           DELETE USER
    //==========================================
    //
    // DELETE /Users/4aa37ddc-4985-4009-ab24-df42d37e2810
    // Note, using id (not username). Explore should therefore set id = username (userID)
    // We then have: DELETE /Users/bjensen
    //
    app.delete('(|/v1)/Users/:id', (req, res) => {
        var id = req.params.id;
        logger.debug(gwName + ' [Delete] id=' + id);
        logger.debug(gwName + ' emitting event "delete-user" and awaiting result');
        this.emit('delete-user', id, function (err) {
            if (err) {
                logger.error(gwName + '[' + pluginName + '] ' + err.message);
                res.status(500).send(gwName + '[' + pluginName + '] ' + err.message);
            }
            else {
                res.status(204).send();
                logger.debug(gwName + '[' + pluginName + '] PATCH = ' + req.originalUrl + ' Response = 204 (OK and no content)');
            }
        });

    }); // delete



    //==========================================
    //          MODIFY USER
    //==========================================
    //
    // PATCH /Users/4aa37ddc-4985-4009-ab24-df42d37e2810
    // Note, using id (not userName). Explore should therefore set id = userName (userID)
    // We then have: PATCH /Users/bjensen
    //
    // Body contains user attributes to be updated
    // example: {"active":true,"schemas":["urn:scim:schemas:core:1.0"]}
    // example multivalue attribute: {"phoneNumbers":[{"type":"work","value":"tel:555-555-5555"},{"operation":"delete","type":"work","value":"tel:555-555-8377"}],"schemas":["urn:scim:schemas:core:1.0"]}
    //
    app.patch('(|/v1)/Users/:id', (req, res) => {
        var id = req.params.id;
        logger.debug(gwName + ' [Modify User] id=' + id);
        var strBody = '';

        req.on('data', function (data) { // get body
            strBody += data;
        });

        req.on('end', () => {        
            logger.debug(gwName + ' PATCH = ' + req.originalUrl + ' Body = ' + strBody);
            var scimdata = JSON.parse(strBody);

            // Modify multivalue element always includes a new element (no "operation" key) + original element to be deleted (operation=delete)
            // We want:
            // * All elements should have a operation key (values: delete / modify / create)
            // * "type" key should be unique, we don't allow several elements with e.g phonenumber type=work in same request
            //   (a none unique type will become overwritten if using several request for a modify user)

            delete scimdata['schemas'];
            var type = [];
            for (var key in scimdata) {
                if (Array.isArray(scimdata[key])) {
                    var arrDel = [];
                    scimdata[key].forEach(function (element, index) {
                        if (element.operation && element.operation === 'delete') {
                            // remove this element from scimdata if similar type found
                            scimdata[key].find(function (newelement, newindex) {
                                if (newelement.type === element.type && (!newelement.operation || newelement.operation === 'create')) {
                                    scimdata[key][newindex].operation = 'modify'; //introducing a new operator
                                    arrDel.push(index); //index to be deleted - removing the operator.delete (or operator.create) element
                                    return true;
                                }
                                else return false;
                            });
                        }
                        else {
                            element.operation = 'create'; // introducing a new operator
                            if (!type[element.type]) type[element.type] = 1;
                            else type[element.type] += 1;
                        }
                    });
                    if (arrDel.length > 0) {
                        var countDel = 0;
                        for (var i in arrDel) {
                            scimdata[key].splice(arrDel[i - countDel], 1);
                            countDel += 1;
                        }
                    }
                }
            }

            errMsg = '';
            for (var key in type) {
                if (type[key] > 1) {
                    errMsg = '"type" must be unique using multivalue attributes! Found multiple entries having the same "type" with value "' + key + '"';
                    break;
                }
            }
            if (errMsg.length > 0) {
                logger.error(gwName + ' ' + errMsg);
                res.status(500).send('ScimGateway ' + gwName + ' ' + errMsg);
            }
            else {
                logger.debug(gwName + ' emitting event "modify-user" and awaiting result');
                    this.emit('modify-user', id, scimdata, function (err) {
                    if (err) {
                        logger.error(gwName + '[' + pluginName + '] ' + err.message);
                        res.status(500).send(gwName + '[' + pluginName + '] ' + err.message);
                    }
                    else {
                        res.status(204).send();
                        logger.debug(gwName + '[' + pluginName + '] PATCH = ' + req.originalUrl + ' Response = 204 (OK and no content)');
                    }
                });
            }
        });
    }); // patch



    //==========================================
    //          MODIFY GROUP MEMBERS
    //
    // PATCH = /Groups/<id>
    // example: PATCH = /Groups/Employees
    //
    // Body contains user attributes to be updated
    // example: {"members":[{"value":"bjensen"}],"schemas":["urn:scim:schemas:core:1.0"]}
    //==========================================
    app.patch('(|/v1)/Groups/:id', (req, res) => {
        var id = req.params.id;
        logger.debug(gwName + ' [Modify Group Members] group id=' + id);
        var strBody = '';

        req.on('data', function (data) { // Get body
            strBody += data;
        });

        req.on('end', () => {
            logger.debug(gwName + ' PATCH = ' + req.originalUrl + ' Body = ' + strBody);
            var scimdata = JSON.parse(strBody);
            scimdata = scimdata.members;
            logger.debug(gwName + ' emitting event "modify-group-members" and awaiting result');
            this.emit('modify-group-members', id, scimdata, function (err) {
                if (err) {
                    logger.error(gwName + '[' + pluginName + '] ' + err.message);
                    res.status(500).send(gwName + '[' + pluginName + '] ' + err.message);
                }
                else {
                    res.status(204).send();
                    logger.debug(gwName + '[' + pluginName + '] PATCH = ' + req.originalUrl + ' Response = 204 (OK and no content)');
                }
            });
        });
    });


    //==========================================
    // Starting up...
    //==========================================

    var orgLevelConsole = logger.transports.console.level;
    var orgLevelFile = logger.transports.file.level;
    logger.transports.console.level = 'info';
    logger.transports.file.level = 'info';

    console.log();
    logger.info('===================================================================');
    if (config.localhostonly == true) {
        logger.info(gwName + ' using ' + pluginName + ' denying other clients than localhost (127.0.0.1)');
        if (config.certificate && config.certificate.key && config.certificate.cert) {
            // SSL
            var server = https.createServer({
                "key": fs.readFileSync(__dirname + '/../config/' + config.certificate.key),
                "cert": fs.readFileSync(__dirname + '/../config/' + config.certificate.cert)
            }, app).listen(config.port, 'localhost');
            logger.info(gwName + ' using ' + pluginName + ' now listening on SSL/TLS port ' + config.port + '...');
        }
        else {
            // none SSL
            var server = http.createServer(app).listen(config.port, 'localhost');
            logger.info(gwName + ' using ' + pluginName + ' now listening on port ' + config.port + '...');
        }
    } else {
        logger.info(gwName + ' using ' + pluginName + ' accepting requests from all clients');
        if (config.certificate && config.certificate.key && config.certificate.cert) {
            // SSL self signed cert e.g: openssl req -nodes -newkey rsa:2048 -x509 -sha256 -days 3650 -keyout key.pem -out cert.pem -subj "/O=NodeJS/OU=Testing/CN=<FQDN>"
            // Note, self signed certificate (cert.pem) also needs to be imported at the CA Connector Server
            var server = https.createServer({
                "key": fs.readFileSync(__dirname + '/../config/' + config.certificate.key),
                "cert": fs.readFileSync(__dirname + '/../config/' + config.certificate.cert),
                "ca": (config.certificate.ca) ? fs.readFileSync(__dirname + '/../config/' + config.certificate.ca) : null,
            }, app).listen(config.port);
            logger.info(gwName + ' using ' + pluginName + ' now listening on SSL/TLS port ' + config.port + '...');
        }
        else {
            // none SSL
            var server = http.createServer(app).listen(config.port);
            logger.info(gwName + ' using ' + pluginName + ' now listening on port ' + config.port + '...');
        }
    }

    logger.transports.console.level = orgLevelConsole;
    logger.transports.file.level = orgLevelFile;


    // die gracefully i.e. wait for existing connections
    var gracefulShutdown = function () {
        server.close(function () {
            logger.debug(gwName + ' using ' + pluginName + ' received kill signal - closed out remaining connections');
            process.exit();
        });
        setTimeout(function () {
            logger.debug(gwName + ' using ' + pluginName + ' received kill signal - Could not close connections in time, forcefully shutting down');
            process.exit(1);
        }, 5 * 1000);
    }

    process.on('SIGTERM', gracefulShutdown); // kill
    process.on('SIGINT', gracefulShutdown);  // Ctrl+C

}; // scimgateway


util.inherits(ScimGateway, EventEmitter);
module.exports = ScimGateway;


function addPagination(data) {
    //Pagination not supported - setting totalResults = itemsPerPage
    if (!data.totalResults) data.totalResults = data.Resources.length; // Specifies the total number of results matching the Consumer query
    data.itemsPerPage = data.Resources.length;                         // Specifies the number of search results returned in a query response page
    if (!data.startIndex) data.startIndex = 1;                         // The 1-based index of the first result in the current set of search results
    return data;
}


function isValidconfig(config, arr) {
    // Check if array elements corresponds with json keys
    for (var i in arr) {
        var key = arr[i];
        var val = config[key];
        if (key === 'localhostonly') { //boolean
            if (val === undefined || typeof (val) !== 'boolean') return false;
        }
        else if (key === 'port') { // number
            if (!val || typeof (val) !== 'number') return false;
        }
        else if (!val || typeof (val) !== 'string') return false; // string
    }
    return true;
}


//
// Check and return none supported attributes
//
var notValidAttributes = function notValidAttributes(obj, validScimAttr) {
    if (validScimAttr.length < 1) return '';
    var tgt = dot.dot(obj);
    var ret = (Object.keys(tgt).filter(function (key) { //{'name.givenName': 'Jarle', emails.0.type': 'work'}
        var arrKey = key.split('.');
        if (arrKey.length === 3 && !isNaN(arrKey[1])) { //array
            if (validScimAttr.indexOf(arrKey[0]) !== -1) return false;
            else if (arrKey[2] === 'type') {
                if (validScimAttr.indexOf(arrKey[0] + '.[].type=' + tgt[key].toLowerCase()) !== -1) return false;
                else return true; //not valid
            }
            else return false;
        }
        else if (key.indexOf('meta.attributes') === 0) return false; // attributes to be cleard not needed in validScimAttr
        else return (validScimAttr.indexOf(key) === -1);
    }));
    if (ret.length > 0) return ret;
    else return null;
}

