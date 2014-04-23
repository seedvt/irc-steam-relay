var Steam = require('steam');
var fs = require('fs');

// if we've saved a server list, use it
if (fs.existsSync('servers')) {
  Steam.servers = JSON.parse(fs.readFileSync('servers'));
}

module.exports = function (details) {
  var msgFormat = details.msgFormat || '\u000302%s\u000f: %s';
  var emoteFormat = details.emoteFormat || '\u000302%s %s';
  var msgFormatGame = details.msgFormatGame || details.msgFormat || '\u000303%s\u000f: %s';
  var emoteFormatGame = details.emoteFormatGame || details.emoteFormat || '\u000303%s %s';

  var queue = [];

  function sendMessage(msg) {
    if (steam.loggedOn) {
      steam.sendMessage(details.chatroom, msg);
    } else {
      queue.push(msg);
    }
  }

  var irc = new(require('irc')).Client(details.server, details.nick, {
    channels: [details.channel]
  });

  irc.on('error', function (err) {
    console.log('IRC error: ', err);
  });

  irc.on('message' + details.channel, function (from, message) {
    sendMessage('<' + from + '> ' + message);

    if (!steam.loggedOn)
      return;

    var parts = message.match(/(\S+)\s+(.*\S)/);

    var triggers = {
      '.k': 'kick',
      '.kb': 'ban',
      '.unban': 'unban'
    };

    if (parts && parts[1] in triggers) {
      irc.whois(from, function (info) {
        if (info.channels.indexOf('@' + details.channel) == -1)
          return; // not OP, go away

        Object.keys(steam.users).filter(function (steamID) {
          return steam.users[steamID].playerName == parts[2];
        }).forEach(function (steamID) {
          steam[triggers[parts[1]]](details.chatroom, steamID);
        });
      });
    } else if (message.trim() == '.userlist') {
      Object.keys(steam.chatRooms[details.chatroom]).forEach(function (steamID) {
        irc.notice(from, steam.users[steamID].playerName + ' http://steamcommunity.com/profiles/' + steamID);
      });
    }
  });

  irc.on('action', function (from, to, message) {
    if (to == details.channel) {
      sendMessage(from + ' ' + message);
    }
  });

  irc.on('+mode', function (channel, by, mode, argument, message) {
    if (channel == details.channel && mode == 'b') {
      sendMessage(by + ' sets ban on ' + argument);
    }
  });

  irc.on('-mode', function (channel, by, mode, argument, message) {
    if (channel == details.channel && mode == 'b') {
      sendMessage(by + ' removes ban on ' + argument);
    }
  });

  irc.on('kick' + details.channel, function (nick, by, reason, message) {
    sendMessage(by + ' has kicked ' + nick + ' from ' + details.channel + ' (' + reason + ')');
  });

  //  irc.on('join' + details.channel, function(nick) {
  //    sendMessage(nick + ' has joined ' + details.channel);
  //  });

  //  irc.on('part' + details.channel, function(nick) {
  //    sendMessage(nick + ' has left ' + details.channel);
  //  });

  //  irc.on('quit', function(nick, reason) {
  //    sendMessage(nick + ' has quit (' + reason + ')');
  //  });

  var steam = new Steam.SteamClient();
  steam.logOn({
    accountName: details.username,
    password: details.password,
    authCode: details.authCode,
    shaSentryfile: require('fs').existsSync('sentry') ? require('fs').readFileSync('sentry') : undefined
  });

  steam.on('servers', function (servers) {
    fs.writeFile('servers', JSON.stringify(servers));
  });

  steam.on('loggedOn', function (result) {
    console.log('Logged on!');

    steam.setPersonaState(Steam.EPersonaState.Online);
    steam.joinChat(details.chatroom);

    queue.forEach(sendMessage);
    queue = [];
  });

  steam.on('chatMsg', function (chatRoom, message, msgType, chatter) {
    var game = steam.users[chatter].gameName;
    var name = steam.users[chatter].playerName;
    if (msgType == Steam.EChatEntryType.ChatMsg) {
      irc.say(details.channel, require('util').format(game ? msgFormatGame : msgFormat, name, message));
    } else if (msgType == Steam.EChatEntryType.Emote) {
      irc.say(details.channel, require('util').format(game ? emoteFormatGame : emoteFormat, name, message));
    }

    var parts = message.split(/\s+/);
    var permissions = steam.chatRooms[chatRoom][chatter].permissions;

    // Append "http://" to the beginning of things that look like URLs
    for (var i = 0; i < parts.length; i++) {
      if( parts[i].match(/^(?!https?:\/\/)(?!www)[^-]([0-9A-Za-z]|-)+\.[A-Za-z]+$/) )
      steam.sendMessage( chatRoom, 'http://' + parts[i] );
    }
    
    if (parts[0] == '.k' && permissions & Steam.EChatPermission.Kick) {
      irc.send('KICK', details.channel, parts[1], 'requested by ' + name);
    } else if (parts[0] == '.kb' && permissions & Steam.EChatPermission.Ban) {
      irc.send('MODE', details.channel, '+b', parts[1]);
      irc.send('KICK', details.channel, parts[1], 'requested by ' + name);

    } else if (parts[0] == '.unban' && permissions & Steam.EChatPermission.Ban) {
      irc.send('MODE', details.channel, '-b', parts[1]);

    } else if (parts[0] == '.userlist') {
      irc.send('NAMES', details.channel);

      irc.once('names' + details.channel, function (nicks) {
        steam.sendMessage(chatter, 'Users in ' + details.channel + ':\n' + Object.keys(nicks).map(function (key) {
          return nicks[key] + key;
        }).join('\n'));
      });
    } else if (message.match(/^http:./) || message.match(/^https:./)) {
      var http = require('http');

      if (message.match(/^https:./)) {
        http = require('https');
      }


      var re = /(<\s*title[^>]*>(.+?)<\s*\/\s*title)>/g;
      http.get(message, function (response) {
        response.on('data', function (chunk) {
          var str = chunk.toString();
          var match = re.exec(str);
          if (match && match[2]) {
            steam.sendMessage(chatRoom, 'Title: ' + match[2]);
          }
        });
      });
/*      
    } else if (message.match(/([^ .][^ ]*\.(?:com|ca|org|co\.uk))/)) {

      var output = 'http://' + message;
      steam.sendMessage(chatRoom, output);
*/
    } else if (parts[0] == '.camel') {
      steam.sendMessage(chatRoom, 'Camel is a spic');
    } else if (parts[0] == '.yallah') {
      var random = Math.floor(Math.random() * 2) // 0 or 1
      if (random == 0) {
        steam.sendMessage(chatRoom, 'YALLAH HABIBI');
      } else {
        steam.sendMessage(chatRoom, '░▒▓ YALLAH HABIBI ▓▒░');
      }
    }

    // Wikipedia search
    else if (parts[0] == '.wiki') {
      if (parts[1] != "" && parts[1] != null) {
        if (parts[1] == 'help') {
          var out = "Usage: .wiki <search term>"
          steam.sendMessage(chatRoom, out);
          return
        }

        var url = 'http://en.wikipedia.org/wiki/' + parts[1];

        for (var i = 2; i < 20; i++) {
          if (parts[i] == "" || parts[i] == null) {
            break
          }
          url += "%20";
          url += parts[i];
        }

      }
      steam.sendMessage(chatRoom, url);
    }


    // Youtube search
    else if (parts[0] == '.yt') {
      if (parts[1] != "" && parts[1] != null) {
        if (parts[1] == 'help') {
          var out = "Usage: .yt <search term>"
          steam.sendMessage(chatRoom, out);
          return
        }

        var url = "http://www.youtube.com/results?search_query=" + parts[1];

        for (var i = 2; i < 20; i++) {
          if (parts[i] == "" || parts[i] == null) {
            break
          }
          url += "+";
          url += parts[i];
        }

      }
      steam.sendMessage(chatRoom, url);
    }
    // IMDB search
    else if (parts[0] == '.imdb') {
      if (parts[1] != "" && parts[1] != null) {
        if (parts[1] == 'help') {
          var out = "Usage: .imdb <search term>"
          steam.sendMessage(chatRoom, out);
          return
        }

        var url = "http://www.imdb.com/find?q=" + parts[1];

        for (var i = 2; i < 20; i++) {
          if (parts[i] == "" || parts[i] == null) {
            break
          }
          url += "+";
          url += parts[i];
        }

      }
      url += '&s=all';
      steam.sendMessage(chatRoom, url);
    }

    // google search
    else if (parts[0] == '.g') {
      if (parts[1] != "" && parts[1] != null) {
        if (parts[1] == 'help') {
          var out = "Usage: .g <search term>"
          steam.sendMessage(chatRoom, out);
          return
        }

        var url = "	https://www.google.ca/#q=" + parts[1];

        for (var i = 2; i < 20; i++) {
          if (parts[i] == "" || parts[i] == null) {
            break
          }
          url += "+";
          url += parts[i];
        }

      }
      steam.sendMessage(chatRoom, url);
    } else if (parts[0] == '.dice') {
      var randomnumber = Math.floor(Math.random() * 5) + 1;
      steam.sendMessage(chatRoom, 'Nigga you rolled a ' + randomnumber);
    } else if (parts[0] == '.rng') {

      if (parts[1] != "" && parts[1] != null) {
        var randomnumber = Math.floor(Math.random() * Number(parts[1]));
        steam.sendMessage(chatRoom, '†††††PRAISE RNGESUS††††† ' + randomnumber);
      } else {
        var out = "Usage: .rng <max>"
        steam.sendMessage(chatRoom, out);
      }
    } else if (parts[0] == '.scrub') {
      steam.sendMessage(chatRoom, '(ง ͠° ͟ʖ ͡°)ง This is our town SCRUB (ง ͠° ͟ʖ ͡°)ง (ง •̀_•́)ง Yeah beat it! (ง •̀_•́)ง.');
    } else if (parts[0] == '.dongers') {
      steam.sendMessage(chatRoom, 'ヽ༼ຈل͜ຈ༽ﾉ raise your dongers ヽ༼ຈل͜ຈ༽ﾉ');
    } else if (parts[0] == '.jdongers') {
      steam.sendMessage(chatRoom, 'ヽ༼ຈل͜ຈ༽ﾉ raise your jaedongers ヽ༼ຈل͜ຈ༽ﾉ');
    } else if (parts[0] == '.weather') {
      var request = require('request');
      var city;
      if (parts[1] != "" && parts[1] != null) {

        if (parts[1] == 'help') {
          var out = "Usage: .weather <city>"
          steam.sendMessage(chatRoom, out);
          return
        }

        if (parts[2] != null) {
          city = parts[1] + "%20" + parts[2];
        } else {
          city = parts[1];
        }
      } else {
        city = 'vancouver';
      }

      var options = {
        url: 'http://api.openweathermap.org/data/2.5/weather?q=' + city,
        headers: {
          'User-Agent': 'request'
        }
      };

      function callback(error, response, body) {
        if (!error && response.statusCode == 200) {
          var info = JSON.parse(body);

          if (info.message == "Error: Not found city") {
            steam.sendMessage(chatRoom, "City not found");
            return
          }

          var name = info.name;
          var country = info.sys.country;
          var temp = Number(info.main.temp) - 273.15;
          var temp_c = temp.toFixed(1) + "°C";
          var rhumidity = info.main.humidity + "%";
          var pressure = info.main.pressure + "hPa";
          var condition = info.weather[0].description;
          var out = name + ", " + country + " | " + temp_c + " | " + condition + " | " + "Rel. Humidity: " + rhumidity + " | " + pressure;
          steam.sendMessage(chatRoom, out);
        } else {
          steam.sendMessage(chatRoom, "Error getting weather (" + response.statusCode + ")");
        }
      }
      request(options, callback);
    } else if (parts[0] == '.mtgox') {
      var MtGox = require('mtgox');
      var gox = new MtGox();
      gox.market('BTCUSD', function (err, market) {
        var last = Number(market.last).toFixed(3) + " USD";
        var high = Number(market.high).toFixed(3) + " USD";
        var low = Number(market.low).toFixed(3) + " USD";
        var vol = market.volume;
        var out = "Last: " + last + " | " + "H: " + high + " | " + "L: " + low + " | " + "Volume: " + vol;
        steam.sendMessage(chatRoom, out);
      });
    } else if (parts[0] == '.halp') {

      var halp = ".halp: Show all available commands";
      var mtgox = ".mtgox: Show Mt.Gox price ticker";
      var weather = ".weather <city>: Show the weather for the input city";
      var yallah = ".yallah: YALLAH HABIBI";
      var camel = ".camel: camelcamelcamel";
      var ncix = ".ncix <item>: Search on NCIX for an SKU or item";
      var dice = ".dice: Roll a six sided die";
      var g = ".g <query>: Search google for the inputted query";
      var wiki = ".wiki <query>: Search wikipedia for the inputted query";
      var rng = ".rng <max>: Generate a pseudo-random number from 0 to <max>";

      var text = "\n" + halp +
        "\n" + mtgox +
        "\n" + weather +
        "\n" + yallah +
        "\n" + camel +
      //"\n" + ncix +
        "\n" + dice +
        "\n" + g +
        "\n" + wiki +
        "\n" + rng;
      steam.sendMessage(chatter, "Available commands:" + text);
    }

  });

  steam.on('chatStateChange', function (stateChange, chatterActedOn, chat, chatterActedBy) {
    var name = steam.users[chatterActedOn].playerName + ' (http://steamcommunity.com/profiles/' + chatterActedOn + ')';
    switch (stateChange) {
    case Steam.EChatMemberStateChange.Entered:
      irc.say(details.channel, name + ' entered chat.');
      break;
    case Steam.EChatMemberStateChange.Left:
      irc.say(details.channel, name + ' left chat.');
      break;
    case Steam.EChatMemberStateChange.Disconnected:
      irc.say(details.channel, name + ' disconnected.');
      break;
    case Steam.EChatMemberStateChange.Kicked:
      irc.say(details.channel, name + ' was kicked by ' + steam.users[chatterActedBy].playerName + '.');
      break;
    case Steam.EChatMemberStateChange.Banned:
      irc.say(details.channel, name + ' was banned by ' + steam.users[chatterActedBy].playerName + '.');
    }
  });

  steam.on('loggedOff', function (result) {
    console.log("Logged off:", result);
  });

  steam.on('sentry', function (data) {
    require('fs').writeFileSync('sentry', data);
  })

  steam.on('debug', console.log);
};