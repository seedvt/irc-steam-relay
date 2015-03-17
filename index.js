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
    /*
	if( parts[0] != '.fezz' ){
      for (var i = 0; i < parts.length; i++) {
        if( parts[i].match(/^(?!https?:\/\/)(?!www)[0-9A-Za-z]([0-9A-Za-z]|-|\.)+\.(com?|ca|net|org|edu|info|biz|me|gov|io)$/i) ){
          sendSteamIRC( 'http://' + parts[i] );
        }
      }
    }
	*/
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
			});
			httprequest.on('error',function err(){sendSteamIRC('Error')});
			
		} else {
		
			var re = /(<\s*title[^>]*>\s*(.+?)\s*<\s*\/\s*title)>/ig;
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
			});
			httprequest.on('error',function err(){sendSteamIRC('Error')});
		}
	
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

    } 
	else if (parts[0] == '.fezz' || parts[0] == '.fez') {
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
      httprequest.on('error',function err(){sendSteamIRC('Error')});

    } 
	// Google search
	else if (parts[0] == '.g') {
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
	else if (parts[0] == '.calc') {
      try {
        var out = eval(message.substring(5))
        out = out.toString();
      } catch (e) {
        var out = 'Error';
      }

      sendSteamIRC( out );
    }
	
	// Print the weather
	else if (parts[0] == '.weather') {

		var request = require('request');

		var GoogleMapsAPIKey = '';
		var ForecastIOAPIKey = '';

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
		var GoogleMapsAPIURL = 'https://maps.googleapis.com/maps/api/geocode/json?address='+city+'&key='+GoogleMapsAPIKey;

		var googleoptions = {
			url: GoogleMapsAPIURL,
			headers: { 'User-Agent': 'request' }
		};
		
		// Parse Google Maps API JSON
		function gmapcallback(error, response, body) {
			var gmaps = JSON.parse(body);
			
			if(gmaps.status == "ZERO_RESULTS") {
				sendSteamIRC("City not found.")
				return;
			}
			
			var formattedAddress = gmaps.results[0].formatted_address;
			var latitude = gmaps.results[0].geometry.location.lat;
			var longitude = gmaps.results[0].geometry.location.lng;
		
			var forecastoptions = {
				url: 'https://api.forecast.io/forecast/'+ForecastIOAPIKey+'/'+latitude+','+longitude,
			};
			
			
			function forecastcallback(error, response, body) {
				var forecast = JSON.parse(body);
				var condition = forecast.currently.summary;
				var pop = forecast.currently.precipProbability;
				var temperature = forecast.currently.temperature;
				var humidity = forecast.currently.humidity;
				var pressure = forecast.currently.pressure;
				var windspeed = forecast.currently.windSpeed;
				var moonPhase = forecast.daily.data[0].moonPhase;
				var moonPhaseStr;
				
				/* moonPhase 
				 * A number representing the fractional part of the lunation number of the given day. 
				 * This can be thought of as the “percentage complete” of the current lunar month: 
				 * a value of 0 represents a new moon, 
				 * a value of 0.25 represents a first quarter moon, 
				 * a value of 0.5 represents a full moon, 
				 * and a value of 0.75 represents a last quarter moon. 
				 * (The ranges in between these represent waxing crescent, waxing gibbous, waning gibbous, and waning crescent moons, respectively.)
				 */

					if(Number(moonPhase) == 0) {
						moonPhaseStr = "new moon";
					}
					else if (Number(moonPhase) > 0 && Number(moonPhase) < 0.25) {
						moonPhaseStr = "waxing crescent";
					}
					else if (Number(moonPhase) == 0.25) {
						moonPhaseStr = "first quarter moon";
					}
					else if (Number(moonPhase) > 0.25 && Number(moonPhase) < 0.5) {
						moonPhaseStr = "waxing gibbous";
					}
					else if (Number(moonPhase) == 0.5) {
						moonPhaseStr = "full moon";
					}
					else if (Number(moonPhase) > 0.5 && Number(moonPhase) < 0.75) {
						moonPhaseStr = "waning gibbous";
					}
					else if (Number(moonPhase) == 0.75) {
						moonPhaseStr = "last quarter moon";
					}
					else {
						moonPhaseStr = "waning crescent";
					}
				output = formattedAddress + ' | ' 
						+ ((Number(temperature) - 32) * 5.0 / 9.0).toFixed(2)  + '°C | ' 
						+ condition + ' | precipitation: ' + (Number(pop)*100).toFixed(1) + '% | humidity: ' + (Number(humidity)*100).toFixed(1) 
						+ '% | pressure: ' + (Number(pressure)).toFixed(0) + 'kPa' 
						+ ' | wind speed: ' + (Number(windspeed)*1.61).toFixed(2) + 'km/h' 
						+ ' | moon phase: ' + moonPhaseStr;

				console.log(output);
				sendSteamIRC(output);		
						
			}  request(forecastoptions, forecastcallback); 
				
		}  request(googleoptions, gmapcallback);

    } 
    else if ( parts[0] == '.fx' ) {
    	var dollars;
    	if( parts[1] ) dollars = Number(parts[1]);
    	if( isNaN(dollars) ) dollars = 1;

	// bank of canada xml feed (closing CAD/USD rate)
	var closing_url = 'http://www.bankofcanada.ca/stats/results//p_xml?rangeType=range&rangeValue=1&lP=lookup_daily_exchange_rates.php&sR=2004-06-26&se=_0102&dF=&dT=';
	var noon_url = 'http://www.bankofcanada.ca/stats/assets/xml/noon-five-day.xml';
	var http = require('http');
    	var util = require('util');

	var noon_date, noon_date_ts, noon_rate;
	var closing_date, closing_date_ts, closing_rate;
	var most_recent_rate, most_recent_date;
	
	// closing rate
	var req = http.get(closing_url, function(res) {
		// save the data
		var xml = '';
		res.on('data', function(chunk) {
			xml += chunk;
		});
		res.on('end', function() {
			// parse xml
			var parseString = require('xml2js').parseString;
			parseString(xml, function(err,result) {
				closing_date_ts = JSON.stringify(result.Currency.Observation[0].Currency_name[0].Observation_date);
				closing_date_ts = closing_date_ts.replace('["', '').replace('"]', '');
				closing_rate = JSON.stringify(result.Currency.Observation[0].Currency_name[0].Observation_data);					closing_rate = closing_rate.replace('["', '').replace('"]', '');
				
				// noon rate
				var req = http.get(noon_url, function(res) {
					// save the data
					var xml = '';
					res.on('data', function(chunk) {
						xml += chunk;
					});
					res.on('end', function() {
					// parse xml
					var parseString = require('xml2js').parseString;
					parseString(xml, function(err,result) {
						noon_date_ts = JSON.stringify(result.Currency.Observation[4].Observation_date);
						noon_date_ts = noon_date_ts.replace('["', '').replace('"]', '');
						noon_rate = JSON.stringify(result.Currency.Observation[4].Observation_data);
						noon_rate = noon_rate.replace('["', '').replace('"]', '');
			
						// Determine which rate is newer
						noon_date = new Date(noon_date_ts);
						closing_date = new Date(closing_date_ts);
						if(closing_date >= noon_date) {
							most_recent_date = closing_date_ts + " (Closing)";
							most_recent_rate = closing_rate;
						}
						else {
							most_recent_date = noon_date_ts + " (Noon)";
							most_recent_rate = noon_rate;
						}
							
						sendSteamIRC("Most Recent Rate: "+ dollars.toFixed(2).toString() + " USD = " 
							+ Number(most_recent_rate*dollars.toFixed(2)).toFixed(4) + " CAD | " 
							+ dollars.toFixed(2).toString() + " CAD = " 
							+ Number(dollars.toFixed(2)/most_recent_rate).toFixed(4) 
							+ " USD | " + "Last updated: " + most_recent_date);
					});
				});
			});
			
		});
	});
});
}
	
	/* else if (parts[0] == '.mtgox' && false ) {
      var MtGox = require('mtgox');
      var gox = new MtGox();
      gox.market('BTCUSD', function (err, market) {
        var last = Number(market.last).toFixed(3) + " USD";
        var high = Number(market.high).toFixed(3) + " USD";
        var low = Number(market.low).toFixed(3) + " USD";
        var vol = market.volume;
        var out = "Last: " + last + " | " + "H: " + high + " | " + "L: " + low + " | " + "Volume: " + vol;
        sendSteamIRC(out);
      });
    } */
	else if( parts[0] == '.starttime' ){
      var now = new Date();
      sendSteamIRC(((now.getTime()-start_time.getTime())/3600000).toFixed(4)  + " hours ago\n" + start_time.toString() );
    } 
	else if( parts[0] == '.utc' ){
      var now = new Date();
      sendSteamIRC( now.toUTCString() );
    } 
	else if (parts[0] == '.halp') {

      var time = Math.round(+new Date()/1000);
      if( lastHalpTime + 60 < time ) {
		lastHalpTime = time;
      } else return;
      

      var halp = ".halp: Show all available commands\n";
      var weather = ".weather <city>: Show the weather for the input city\n";
      var g = ".g <query>: Search google for the inputted query\n";
      var wiki = ".wiki <query>: Search wikipedia for the inputted query\n";
	  var imdb = ".imdb <title>: Search for a movie/tv in the internet movie database\n";
	  var yt = ".yt <query>: Search for a youtube video with the inputted query\n";
	  var nhl = ".nhl: Shows today's NHL score board\n";
		
      sendSteamIRC("Available commands:\n" + halp + weather + g + wiki + imdb + yt + nhl);
	  
    } 
	else if (parts[0] == '.nhl') {
		var request = require('request');
		var today = new Date();
		
		// Offset GMT bug on VPS
		today.setHours(today.getHours() - 8);
		
		var dd = today.getDate();
		var mm = today.getMonth()+1;
		var yyyy = today.getFullYear();

		if(dd<10) {
			dd='0'+dd
		} 

		if(mm<10) {
			mm='0'+mm
		} 

		today = yyyy+'-'+mm+'-'+dd;

		var options = {
			url: 'http://live.nhle.com/GameData/GCScoreboard/'+today+'.jsonp',
		};
			
		function nhlcallback(error, response, body) {

			var scoreboard = JSON.parse(body.replace('loadScoreboard(', '').replace('})', '}'));
			
			var output = 'NHL games today: \n';
			for(var i = 0; i < scoreboard.games.length; i++) {
				
				output += scoreboard.games[i].ata + ' ' + scoreboard.games[i].ats + ' '
							+ scoreboard.games[i].hta + ' ' + scoreboard.games[i].hts + ' / ' 
							+ scoreboard.games[i].bs + '\n';
			}
			
			sendSteamIRC(output);
			
		} request(options, nhlcallback);
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
	  /^Gotham.?S\d\dE\d\d.*(PDTV|HDTV).*/i,
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
	  /^Restaurant.?Impossible.?S\d\dE\d\d.*(PDTV|HDTV).*/i,
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
	  /^The.?Flash.?\d\d\d\d.?S\d\dE\d\d.*(PDTV|HDTV).*/i,
      /^The.?Big.?Bang.?Theory.?S\d\dE\d\d.*(PDTV|HDTV).*/i,
      /^The.?Good.?Wife.?S\d\dE\d\d.*(PDTV|HDTV).*/i,
      /^The.?Office.*S\d\dE\d\d.*(PDTV|HDTV).*/i,
      /^The.?Real.?World.?S\d\dE\d\d.*(PDTV|HDTV).*/i,
      /^The.?Simpsons.?S\d\dE\d\d.*(PDTV|HDTV).*/i,
      /^The.?Walking.?Dead.?S\d\dE\d\d.*(PDTV|HDTV).*/i,
      /^The.?Voice.?S\d\dE\d\d.*(PDTV|HDTV).*/i,
      /^Top.?Chef.?S\d\dE\d\d.*(PDTV|HDTV).*/i,
      /^Top.?Gear.?(?:S\d\dE\d\d|\d\d.\d\d).*(PDTV|HDTV).*/i,
      /^Two.?and.?a.?Half.?Men.?S\d\dE\d\d.*(PDTV|HDTV).*/i,
      /^Undercover.?Boss.?S\d\dE\d\d.*(PDTV|HDTV).*/i,
	  /^Wizard.?Wars.?S\d\dE\d\d.*(PDTV|HDTV).*/i,
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
      }else if( parts[2] == 'XXX' && Math.random() < 0 ){
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

