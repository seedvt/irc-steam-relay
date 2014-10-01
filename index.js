var Steam = require('steam');
var fs = require('fs');
var lastHalpTime = 0; // Use this to keep track of when we last printed the .halp dialog

/**********
 Set to: 0 - no messages from chatbot
         1 - only relays chat messages, does not process commands
         2 - relays chat messages and processes commands
         3 - prints IRC join/quits to Steam
 **********/
var verbose = 2;

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
  var pre = [];
  var start_time = new Date();

  function sendMessage(msg){
    if (steam.loggedOn) {
      steam.sendMessage(details.chatroom, msg);
    } else {
      queue.push(msg);
      if( queue.length > 3 ){
        console.log("QUEUE FULL. EXITING");
        exit;
      }
    }
  }

  /***********
   IRC SIDE HANDLING
   ************/

  var irc = new(require('irc')).Client(details.server, details.nick, {
    channels: [details.channel]
  });

  irc.on('error', function (err) {
    console.log('IRC error: ', err);
  });

  irc.on('message' + details.channel, function (from, message) {
    var parts = message.match(/(\S+)\s+(.*\S)/);

    if(parts && ( parts[1] == '.bot' || parts[1] == '.b' )){
      sendMessage( message.substring(5) );
    }else{
      if( verbose ){
        sendMessage('<' + from + '> ' + message);
      }
    }

    if (!steam.loggedOn)
      return;

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
    } else if ( parts && parts[1] && parts[1] == '.verbose' ) {
      if( ! Number(parts[2]) == 'NaN' ){
        verbose = Number(parts[2]);
      }
    }

    doBotThings(message);
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

  if( verbose > 2 ){
    irc.on('join' + details.channel, function(nick) {
     sendMessage(nick + ' has joined ' + details.channel);
    });

    irc.on('part' + details.channel, function(nick) {
     sendMessage(nick + ' has left ' + details.channel);
    });

    irc.on('quit', function(nick, reason) {
     sendMessage(nick + ' has quit (' + reason + ')');
    });
  }

  /***********
   STEAM SIDE HANDLING
   ************/

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
    if (verbose && msgType == Steam.EChatEntryType.ChatMsg) {
      irc.say(details.channel, require('util').format(game ? msgFormatGame : msgFormat, name, message));
    } else if (msgType == Steam.EChatEntryType.Emote) {
      irc.say(details.channel, require('util').format(game ? emoteFormatGame : emoteFormat, name, message));
    }

    var parts = message.split(/\s+/);
    var permissions = steam.chatRooms[chatRoom][chatter].permissions;

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
    }

    doBotThings(message);
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

  function sendSteamIRC(msg){
    sendMessage(msg);
    irc.say(details.channel, msg );
  }

  /*******
   Function used to handle commands common to Steam & IRC
   *******/
  function doBotThings(message){

    if( verbose < 2 ){
      return;
    }

    var parts = message.split(/\s+/);

    // Append "http://" to the beginning of things that look like URLs
    if( parts[0] != '.fezz' ){
      for (var i = 0; i < parts.length; i++) {
        if( parts[i].match(/^(?!https?:\/\/)(?!www)[0-9A-Za-z]([0-9A-Za-z]|-|\.)+\.(com?|ca|net|org|edu|info|biz|me|gov|io)$/i) ){
          sendSteamIRC( 'http://' + parts[i] );
        }
      }
    }

    // Fetch the title for a URL
    if ( parts[0].match(/^https?:./) ) {
      var http = require('http');

      if (parts[0].match(/^https:./)) {
        http = require('https');
      }
      
      if( parts[0].match(/^https?:\/\/twitter\.com/ ) ){
      
        var re = /<p class="js-tweet-text tweet-text">(.*?)<\/p>/;
        var httprequest = http.get(parts[0], function (response) {
          response.on('data', function (chunk) {
            var str = chunk.toString();
            var match = re.exec(str);
            if (match) {
              console.log( "Twitter: " + match[1].replace(/<.*?>/gi, "").decodeHTML() );
              return;
            }
          });
        } );
        httprequest.on('error',function err(){sendSteamIRC('u wot m8')});
      
      } else {
      
        var re = /(<\s*title[^>]*>(.+?)<\s*\/\s*title)>/ig;
        var httprequest = http.get(parts[0], function (response) {
          response.on('data', function (chunk) {
            var str = chunk.toString();
            var match = re.exec(str);
            if (match && match[2]) {
              if( match[2].length > 93 )
                sendSteamIRC('Title: ' + (match[2].substring(0,90)).decodeHTML().trim() + '...');
              else
                sendSteamIRC('Title: ' + match[2].decodeHTML() );
            }
          });
        } );
        httprequest.on('error',function err(){sendSteamIRC('u wot m8')});
    }

    // Wikipedia search
    else if (parts[0] == '.wiki') {
      if (parts[1] != "" && parts[1] != null) {
        if (parts[1] == 'help') {
          var out = "Usage: .wiki <search term>"
          sendSteamIRC(out);
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
        sendSteamIRC(url);
      }
    }

    // Youtube search
    else if (parts[0] == '.yt') {
      if (parts[1] != "" && parts[1] != null) {
        if (parts[1] == 'help') {
          "Usage: .yt <search term>"
          sendSteamIRC(out);
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
      sendSteamIRC(url);
    }
    // IMDB search
    else if (parts[0] == '.imdb') {
      if (parts[1] != "" && parts[1] != null) {
        if (parts[1] == 'help') {
          var out = "Usage: .imdb <search term>"
          sendSteamIRC(out);
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
        url += '&s=all';
        sendSteamIRC(url);
      }

    } else if (parts[0] == '.fezz' || parts[0] == '.fez') {
      var http = require('http');
      if( ! parts[1] )
        return;
      var url = parts[1];
      if( parts[1].match(/^(?!https?:\/\/)[^-]([0-9A-Za-z]|-|\.)+\.(com?|ca|net|org|edu|info|biz|me|gov|io).*/) )
        url = 'http://' + parts[1];
      var httprequest = http.get( 'http://fezz.es/url/shorten.php?bare=1&url=' + url, function (response) {
        response.on('data', function (chunk) {
          var str = chunk.toString();
          sendSteamIRC(str);
        });
      } );
      httprequest.on('error',function err(){sendSteamIRC('u wot m8')});

    // Google search
    } else if (parts[0] == '.g') {
      if( parts[1] != "" && parts[1] != null ){
        if (parts[1] == 'help') {
          var out = "Usage: .g <search term>"
          sendSteamIRC(out);
          return
        }

        var url = "https://www.google.ca/#q=" + parts[1];

        for (var i = 2; i < 20; i++) {
          if (parts[i] == "" || parts[i] == null) {
            break
          }
          url += "+";
          url += parts[i];
        }
        sendSteamIRC(url);
      }
    }

    // Print the weather
    } else if (parts[0] == '.weather') {
      var request = require('request');
      var city;
      if (parts[1] != "" && parts[1] != null) {

        if (parts[1] == 'help') {
          var out = "Usage: .weather <city>"
          sendSteamIRC(out);
          return
        }

        if (parts[2] != null) {
          city = parts[1] + "%20" + parts[2];
        } else {
          city = parts[1];
        }
      } else {
        city = 'vancouver ca';
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
            sendSteamIRC("City not found");
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
          sendSteamIRC(out);
        } else {
          sendSteamIRC("Error getting weather (" + response.statusCode + ")");
        }
      }
      request(options, callback);
    } else if (parts[0] == '.andrew' || parts[0] == '.asharp'){
      sendSteamIRC('Andrew is a nigger');
    }else if (parts[0] == '.justin' || parts[0] == '.perijah' || parts [0] == '.peri' ){
      if( Math.random() < .075 ){
        sendSteamIRC('http://www.videosexart.com/play/129344/Brunette-masturbates');
        var sleep = require('sleep');
        sleep.sleep(5/2.5) //sleep for 2 seconds
        while(queue.length() != 0);
        exit;
      } else {
        sendSteamIRC('Andrew is a nigger');
      }
    } else if (parts[0] == '.adamchan' || parts[0] == '.fx' ) {
      var dollars;

      if( parts[1] )
        dollars = Number(parts[1]);
      if( isNaN(dollars) )
        dollars = 1;

      // bank of canada xml feed (daily CAD/USD rate)
      var url = 'http://www.bankofcanada.ca/stats/results//p_xml?rangeType=range&rangeValue=1&lP=lookup_daily_exchange_rates.php&sR=2004-06-26&se=_0102&dF=&dT=';
      var http = require('http');
      var util = require('util');
      var req = http.get(url, function(res) {
        // save the data
        var xml = '';
        res.on('data', function(chunk) {
                xml += chunk;
        });

        res.on('end', function() {
          // parse xml
          var parseString = require('xml2js').parseString;
          parseString(xml, function(err,result) {
            var rate = JSON.stringify(result.Currency.Observation[0].Currency_name[0].Observation_data);
            var date = JSON.stringify(result.Currency.Observation[0].Currency_name[0].Observation_date);
            rate = rate.replace('["', '');
            rate = rate.replace('"]', '');
            date = date.replace('["', '');
            date = date.replace('"]', '');
            // out = "USD/CAN closing rate\n" + rate + " CAD = 1 USD\n" + Number(1/rate).toFixed(4) + " USD = 1 CAD\n" + "Last updated: " + date;
            out = dollars.toFixed(2).toString() + " USD = " + Number(rate*dollars.toFixed(2)).toFixed(4) + " CAD | " + dollars.toFixed(2).toString() + " CAD = " + Number(dollars.toFixed(2)/rate).toFixed(4) + " USD | " + "Last updated: " + date;
            // out = rate + " CAD = 1 USD | " + Number(1/rate).toFixed(4) + " USD = 1 CAD | " + "Last updated: " + date;
            sendSteamIRC(out);
            //console.log(out);
          });
        });
      });
    } else if( parts[0] == '.starttime' ){
      var now = new Date();
      sendSteamIRC(((now.getTime()-start_time.getTime())/3600000).toFixed(4)  + " hours ago\n" + start_time.toString() );

    } else if( parts[0] == '.utc' ){
      var now = new Date();
      sendSteamIRC( now.toUTCString() );
    }else if (parts[0] == '.halp') {

      var time = Math.round(+new Date()/1000);
      if( lastHalpTime + 60 < time ){
        lastHalpTime = time;
      }else{
        return;
      }

      var halp = ".halp: Show all available commands";
      var weather = ".weather <city>: Show the weather for the input city";
      var ncix = ".ncix <item>: Search on NCIX for an SKU or item";
      var g = ".g <query>: Search google for the inputted query";
      var wiki = ".wiki <query>: Search wikipedia for the inputted query";

      var text = "\n" + halp +
        "\n" + mtgox +
        "\n" + weather +
        "\n" + g +
        "\n" + wiki;
      sendSteamIRC("Available commands:" + text);
    } 
  }

  /***********
   PREBOT
   ************/

  pre_server = 'irc.corrupt-net.org';
  pre_chan = '#pre';
  nick = 'han_yolo';

  var irc_pre = new(require('irc')).Client(pre_server, nick, {
    channels: [pre_chan]
  });

  irc_pre.on('error', function (err) {
    console.log('IRC error: ', err);
  });

  irc_pre.on('message' + pre_chan, function (from, message) {

    var accept = [
      /^XXAdobe.*/i,
      /^Mathworks.?Matlab.*/i,
      /^Microsoft.?Office.*/i,
      /^Rarlab.?Winrar.*/i,
      /^Formula.?1.*(PDTV|HDTV).*/i,
      /^NASCAR.*(PDTV|HDTV).*/i,
      /^.*Bieber.*/i,
      /^NHL.*/,

      /^2.?Broke.?Girls.?S\d\dE\d\d.*(PDTV|HDTV).*/i,
      /^24.?S\d\dE\d\d.*(PDTV|HDTV).*/i,
      /^Air.?Crash.?Investigation.?S\d\dE\d\d.*/i,
      /^American.?Dad.?S\d\dE\d\d.*(PDTV|HDTV).*/i,
      /^American.?Idol.?S\d\dE\d\d.*(PDTV|HDTV).*/i,
      /^Anthony.?Bourdain.*S\d\dE\d\d.*(PDTV|HDTV).*/i,
      /^Anger.?Management.?S\d\dE\d\d.*(PDTV|HDTV).*/i,
      /^Archer.?S\d\dE\d\d.*(PDTV|HDTV).*/i,
      /^Britain.?s.?Got.?Talent.?S\d\dE\d\d.*(PDTV|HDTV).*/i,
      /^Bob.?s.?Burgers.?S\d\dE\d\d.*(PDTV|HDTV).*/i,
      /^Californication.?S\d\dE\d\d.*(PDTV|HDTV).*/i,
      /^Chicago.*S\d\dE\d\d.*(PDTV|HDTV).*/i,
      /^Community.?S\d\dE\d\d.*(PDTV|HDTV).*/i,
      /^Continuum.?S\d\dE\d\d.*(PDTV|HDTV).*/i,
      /^Cosmos.*S\d\dE\d\d.*(PDTV|HDTV).*/i,
      /^Dragon.?s.?Den.?S\d\dE\d\d.*(PDTV|HDTV).*/i,
      /^Family.?Guy.?S\d\dE\d\d.*(PDTV|HDTV).*/i,
      /^Game.?of.?Thrones.?S\d\dE\d\d.*(PDTV|HDTV).*/i,
      /^Girls.?S\d\dE\d\d.*(PDTV|HDTV).*/i,
      /^Glee.?S\d\dE\d\d.*(PDTV|HDTV).*/i,
      /^Gordon.?Ramsay.*S\d\dE\d\d.*(PDTV|HDTV).*/i,
      /^Grey.?s.?Anatomy.?S\d\dE\d\d.*(PDTV|HDTV).*/i,
      /^Hannibal.?S\d\dE\d\d.*(PDTV|HDTV).*/i,
      /^Hawaii.?Five.?0.?S\d\dE\d\d.*(PDTV|HDTV).*/i,
      /^Hell.?s.?Kitchen.*S\d\dE\d\d.*(PDTV|HDTV).*/i,
      /^James.?May.*S\d\dE\d\d.*(PDTV|HDTV).*/i,
      /^Kitchen.?Nightmares.*S\d\dE\d\d.*(PDTV|HDTV).*/i,
      /^Law.?and.?Order.*S\d\dE\d\d.*(PDTV|HDTV).*/i,
      /^Luther.?S\d\dE\d\d.*(PDTV|HDTV).*/i,
      /^Mad.?Men.?S\d\dE\d\d.*(PDTV|HDTV).*/i,
      /^Marvel.?s.?Agents.?of.?S.?H.?I.?E.?L.?D.?S\d\dE\d\d.*(PDTV|HDTV).*/i,
      /^Masterchef.?US.?S\d\dE\d\d.*(PDTV|HDTV).*/i,
      /^Mike.?and.?Molly.?S\d\dE\d\d.*(PDTV|HDTV).*/i,
      /^Modern.?Family.?S\d\dE\d\d.*(PDTV|HDTV).*/i,
      /^Nashville.?S\d\dE\d\d.*(PDTV|HDTV).*/i,
      /^NCIS.*S\d\dE\d\d.*(PDTV|HDTV).*/i,
      /^Orange.?is.?the.?New.?Black.?S\d\dE\d\d.*(PDTV|HDTV).*/i,
      /^Parenthood.*S\d\dE\d\d.*(PDTV|HDTV).*/i,
      /^Parks.?and.?Recreation.?S\d\dE\d\d.*(PDTV|HDTV).*/i,
      /^Pretty.?Little.?Liars.?S\d\dE\d\d.*(PDTV|HDTV).*/i,
      /^Richard.?Hammond.*S\d\dE\d\d.*(PDTV|HDTV).*/i,
      /^Rookie.?Blue.?S\d\dE\d\d.*(PDTV|HDTV).*/i,
      /^Silicon.?Valley.?S\d\dE\d\d.*(PDTV|HDTV).*/i,
      /^Shark.?Tank.?S\d\dE\d\d.*(PDTV|HDTV).*/i,
      /^Shipping.?Wars.?S\d\dE\d\d.*(PDTV|HDTV).*/i,
      /^Snookie.*JWOWW.*S\d\dE\d\d.*(PDTV|HDTV).*/i,
      /^Storage.?Wars.*S\d\dE\d\d.*(PDTV|HDTV).*/i,
      /^Suits.?S\d\dE\d\d.*(PDTV|HDTV).*/i,
      /^The.?Amazing.?Race.?S\d\dE\d\d.*(PDTV|HDTV).*/i,
      /^The.?Americans.*S\d\dE\d\d.*(PDTV|HDTV).*/i,
      /^The.?Big.?Bang.?Theory.?S\d\dE\d\d.*(PDTV|HDTV).*/i,
      /^The.?Good.?Wife.?S\d\dE\d\d.*(PDTV|HDTV).*/i,
      /^The.?Office.*S\d\dE\d\d.*(PDTV|HDTV).*/i,
      /^The.?Real.?World.?S\d\dE\d\d.*(PDTV|HDTV).*/i,
      /^The.?Simpsons.?S\d\dE\d\d.*(PDTV|HDTV).*/i,
      /^The.?Walking.?Dead.?S\d\dE\d\d.*(PDTV|HDTV).*/i,
      /^The.?Voice.?S\d\dE\d\d.*(PDTV|HDTV).*/i,
      /^Top.?Gear.?S\d\dE\d\d.*(PDTV|HDTV).*/i,
      /^Two.?and.?a.?Half.?Men.?S\d\dE\d\d.*(PDTV|HDTV).*/i,
      /.*-(RELOADED|SKIDROW|CODEX|TPTB|DEFA|VITALITY|HATRED|FLT|FAIRLIGHT|Razor1911|DAGGER|JFKPC|DEViANCE|PROPHET|BAT|DOGE|FASiSO|TiNYiSO|POSTMORTEM|HI2U|SANTA|iNLAWS|FANiSO)$/i ];
    var reject = [ /XXX/i, /S\d\dE\d\d.*(?:DVD|BluRay|FRENCH|SPANISH|GERMAN|ITALIAN|DUTCH|DUBBED|SUBBED|PL|POLISH|NL).*-.*/i, /^Formula.?1.*(?:SWEDISH|NORWEGIAN|SPANISH|DANISH|FRENCH|POLISH).*/i ];

    function matchInArray(string, expressions) {
      for( var i = 0; i < expressions.length; i++){
        if (string.match(expressions[i])) {
            return true;
        }
      }
      return false;
    };

    if( verbose < 2 )
      return;

    if( from != 'PR3' )
      return;

    if (!steam.loggedOn)
      return;

    // Drop non-ASCII characters
    message = message.replace(/[^A-Za-z 0-9 \.,\?""!@#\$%\^&\*\(\)-_=\+;:<>\/\\\|\}\{\[\]`~]*/g, '')

    var parts = message.match(/^\d{0,2}(PRE|NUKE|UNNUKE):\s+(?:\[\d{0,2}([^\]]*)\]\s+)?(.*)/);
    if( parts && parts[0] && parts[3] && verbose >=2 ){
      for( var i = 0; i < parts.length; i++ )
        console.log(i+' '+parts[i]);
      if( matchInArray(parts[3],accept) && ! matchInArray(parts[3],reject) ){
        pre.push(parts[3]);
        sendSteamIRC( '['+parts[1]+'] ' + (parts[3]).replace(/\[\d\d/,'[') );
      }else if( parts[2] == 'XXX' && Math.random() < .01 ){
        sendSteamIRC( '['+parts[1]+'] ' + (parts[3]).replace(/\[\d\d/,'[') );
      }
    }
  });

};

String.prototype.decodeHTML = function(){
  var jsdom = require("jsdom"); 
  var $ = require("jquery")(jsdom.jsdom().createWindow()); 
  return $("<div/>").html(this).text();
}

