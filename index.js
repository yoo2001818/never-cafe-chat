// 의존성 모듈
var CSON, async, ncc, irc, tough, request;
try {
    CSON = require('cursive');
    async = require('async');
    tough = require('tough-cookie');
    request = require('request');
    ncc = require('node-ncc');
    irc = require('irc');
} catch (e) {
    console.log('봇을 실행하기 전에 먼저 다음 명령을 실행해주세요: ');
    console.log('npm install .');
    process.exit(1);
}
// node.js api
var fs = require('fs');
var util = require('util');
var path = require('path');

// 사용자 설정
var config;
try {
    config = require('cursive').parse(fs.readFileSync('config.cson', {encoding: 'utf8'}));
} catch (e) {
    console.log('설정파일(`config.cson`)을 먼저 작성해주세요.');
    console.log('설정파일은 `sample-config.cson`의 내용같이 작성해주시면 됩니다.');
    process.exit(2);
}
console.log('설정파일 정보:', util.inspect(config, {depth: 10}));

// 쿠키 정보 로드
var cookieJar = new request.jar();
try {
    var cookieText = fs.readFileSync('cookie.json', 'utf8');
    var cookieList = JSON.parse(cookieText);
    for(var key in cookieList) {
        // TODO Dirty method
        var cookie = tough.Cookie.fromJSON(JSON.stringify(cookieList[key]));
        cookieJar._jar.store.putCookie(cookie, function () {});
    }
    console.log("Loaded cookies.");
} catch (e) {
}

var userID; // 카페 채팅 아이디
var session; // 카페 채팅 세션
var selectedChatRoom; // 선택된 채팅방
/*
    이후 처리 순서:
     * 네이버 로그인
     * 카페 채팅방 접속
     * irc 서버 및 채널 접속
     * 대화 중계 시작
*/
// 아래 두 큐는 중계에 사용됨
var cafeChatQueue = []; // 네이버 카페 채팅 대화 큐
var ircChannelQueue = []; // irc 대화 큐
async.waterfall([
    function (callback) { // 로그인 정보 검증
        console.log("로그인 정보 검증하는 중...");
        ncc.validateLogin(cookieJar, function (data) {
            if(data == null) {
                console.log("로그인 하는 중...");
                callback(null, false);
            } else {
                console.log("아이디 " + data + "로 이미 로그인 되어 있습니다.");
                userID = data;
                callback(null, true);
            }
        });
    },
    function (logged, callback) { // 로그인이 되어 있지 않다면 로그인
        if(logged) {
            callback(null);
            return;
        }
        ncc.login(config.naver.id, config.naver.pw, function (error, data) {
            if(error) {
                console.log(error);
                process.exit(3);
                return;
            }
            console.log("로그인 했습니다.");
            cookieJar = data;
            userID = config.id;
            var cookieList = cookieJar.getCookies('https://nid.naver.com/');
            fs.writeFile('cookie.json', JSON.stringify(cookieList), function (error) {
                if(error) throw error;
                callback(null);
            });
        });
    },
    function (callback) { // 카페 채팅 세션 만들고 접속
        console.log("채팅 서버에 접속하는 중입니다.");
        session = new ncc.Session(userID, cookieJar);
        session.connect(function (error) {
            if(!!error) {
                console.log(error);
                process.exit(4);
                return;
            }
            callback(null);
        });
    },
    function (callback) { // 방 목록 받아오기
        console.log("방 목록을 불러오는 중입니다.");
        session.requestChatRoomList(function (error) {
          if(!!error) {
              console.log(error);
              process.exit(5);
              return;
          }
          for(var key in session.chatRooms) {
            var chatRoom = session.chatRooms[key];
            if(chatRoom.roomId == config.naver['chat-room']) {
              console.log("채팅방 "+chatRoom.roomName+"을(를) 찾았습니다.");
              selectedChatRoom = chatRoom;
            }
          }
          if(!selectedChatRoom) {
            console.log("설정 파일에 작성된 채팅방을 찾을 수 없습니다.");
            console.log("채팅방이 존재하는지 확인해 주세요.");
            process.exit(6);
          }
          callback();
        });
    },
    function (callback) { // 방 정보 받아오기
        console.log("방 정보를 받아오는 중입니다.");
        session.requestChatRoomInfo(selectedChatRoom, function(error, data) {
            if(!!error) {
              console.log(error);
              process.exit(6);
              return;
            }
            console.log('방 정보:', data);
            callback();
        });
    },
    function (callback) { // 네이버 카페 채팅 로깅
        console.log('지금부터 네이버 카페 채팅이 로깅됩니다.');
        session.on('all_message', function(message) {
          if(message.chatRoom == selectedChatRoom) {
            cafeChatQueue.push(message); // 큐에 쌓음
            console.log("카페 채팅:",message.sender.nickname,":",message.message);
          }
        });
        callback();
    },
    function (callback) { // irc 채널 접속 및 채팅 로깅
        console.log('irc 채널 접속중...');
        var ircClient = new irc.Client(config.irc.server, config.irc.nick, {
            port: config.irc.port,
            secure: config.irc.secure,
            autoRejoin: true,
            autoConnect: true,
            channels: [config.irc.channel]
        });
        function channelEvent(event) {
            return event + config.irc.channel;
        }
        ircClient.addListener('error', function(info) {
            console.log('irc 에러:', util.inspect(info, {depth: 10}));
        });
        ircClient.addListener(channelEvent('join'), function (nick, message) {
            if (nick == config.irc.nick) {
                console.log('irc 채널 접속 성공.');
                console.log('지금부터 irc 채팅이 로깅됩니다.');
                callback(null, ircClient); // 중계 시작
            }
            console.log('irc 채팅방에 ' + nick + '님이 들어왔습니다.');
            ircChannelQueue.push({
                type: 'join',
                nick: nick
            });
        });
        ircClient.addListener(channelEvent('part'), function (nick, message) {
            console.log(nick + '님이 irc 채팅방을 나가셨습니다.');
            ircChannelQueue.push({
                type: 'part',
                nick: nick
            });
        });
        ircClient.addListener('quit', function (nick, reason, channels, message) {
            if (channels.indexOf(config.irc.channel) < 0) return; // 이 채널에 있던 사람이 아니면 무시
            console.log(nick + '님이 irc 서버에서 나가셨습니다: ' + reason);
            ircChannelQueue.push({
                type: 'quit',
                nick: nick,
                reason: reason
            });
        });
        ircClient.addListener('action', function (from, to, text, message) {
            if (to !== config.irc.channel) return; // 이 채널을 대상으로 한 행동이 아니면 무시
            console.log('irc 채팅:', util.inspect(message, {depth: 10}));
            ircChannelQueue.push({
                type: 'action',
                nick: from,
                message: text
            });
        });
        ircClient.addListener(channelEvent('message'), function (nick, text, message) {
            console.log('irc 채팅:', util.inspect(message, {depth: 10}));
            ircChannelQueue.push({
                type: 'message',
                nick: nick,
                message: text
            });
        });
    },
    function (ircClient, callback) { // 채팅방간 중계
        console.log('네이버 카페 채팅 <-> irc 채널간 중계를 시작합니다.');
        talkToIRC(ircClient, selectedChatRoom.roomName+'와(과) 중계를 시작합니다.');
        function checkMentioned(message) {
            var nick = config.irc.nick;
            var length = nick.length;
            return message.substr(0, length) === nick && / |,|:/.test(message.charAt(length));
        }
        setInterval(function () { // 1초당 100번씩, 쌓인 대화 중계
            while (cafeChatQueue.length > 0) { // 카페 채팅 큐가 바닥날 때까지
                (function (data) { // irc 채널로 내용 중계
                    talkToIRC(ircClient, [
                            'ㅁ ',data.sender.nickname, ': ', data.message
                        ].join(''));
                })(cafeChatQueue.shift());
            }
            while (ircChannelQueue.length > 0) { // irc 채널 큐가 바닥날 때까지
                (function (data) { // 카페 채팅으로 내용 중계
                    if (!!config.irc['optional-relay']) { // optional-relay 옵션이 켜져있으면
                        if (data.type === 'message' && checkMentioned(data.message)) { // message만 봇이 멘션될 경우 전송
                            talkToNaverCafeChat([
                                data.nick,': ', data.message.substr(config.irc.nick.length+1)
                            ].join(''));
                        }
                        if (data.type === 'message' && data.message.slice(0, 2) == 'ㅁ ') { // message만 봇이 멘션될 경우 전송
                            talkToNaverCafeChat([
                                data.nick,': ', data.message.substr(2)
                            ].join(''));
                        }
                        return; // 다른 타입은 무시
                    }
                    switch (data.type) {
                    case 'message':
                        talkToNaverCafeChat([
                            data.nick,': ', data.message
                        ].join(''));
                        break;
                    case 'action':
                        talkToNaverCafeChat( [
                            '\"', data.nick, ' ', data.message, '\"'
                        ].join(''));
                        break;
                    case 'join':
                        talkToNaverCafeChat([
                            ':: irc 채널에 ', data.nick,'님이 들어왔습니다. ::'
                        ].join(''));
                        break;
                    case 'part':
                        talkToNaverCafeChat([
                            ':: ', data.nick,'님이 irc 채널을 나갔습니다. ::'
                        ].join(''));
                        break;
                    case 'quit':
                        talkToNaverCafeChat([
                            ':: ', data.nick,'님이 \"', data.reason, '\"라고 외치며 irc 서버를 나갔습니다. ::'
                        ].join(''));
                        break;
                    default: break; // 필요없는 타입은 무시
                    }
                })(ircChannelQueue.shift());
            }
        }, 50);
    }
], function (err) {
    if (err) {
        console.log(err);
        process.exit(3);
    }
});

function talkToNaverCafeChat(message) {
    session.sendText(selectedChatRoom, message);
}

function talkToIRC(ircClient, message) {
    ircClient.say(config.irc.channel, message);
}
