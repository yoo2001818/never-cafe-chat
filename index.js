// 의존성 모듈
var CSON, async, phantomjs_node, irc;
try {
    CSON = require('cursive');
    async = require('async');
    phantomjs_node = require('phantom');
    irc = require('irc');
} catch (e) {
    console.log('봇을 실행하기 전에 먼저 다음 명령을 실행해주세요: ');
    console.log('npm install .');
    process.exit(1);
}
// node.js api
var fs = require('fs');
var util = require('util');

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

/*
    이후 처리 순서:
     * 네이버 로그인
     * 카페 채팅방 접속
     * irc 서버 및 채널 접속
     * 대화 중계 시작
*/
var phantom; // phantomjs 객체
// 아래 두 큐는 중계에 사용됨
var cafeChatQueue = []; // 네이버 카페 채팅 대화 큐
var ircChannelQueue = []; // irc 대화 큐
async.waterfall([
    function (callback) { // phantom 객체 생성 및 네이버 페이지 접속
        var args = config.phantom.args.concat({port: config.phantom.port}, function (ph) {
            phantom = ph;
            console.log('네이버 페이지 접속 시도중...');
            var naver;
            phantom.createPage(function (page) {
                naver = page;
                naver.set('settings.userAgent', config['user-agent']);
                naver.open('http://www.naver.com/', function (status) {
                    if (status == 'success') {
                        console.log('네이버 접속 성공.');
                        callback(null, naver);
                    } else {
                        callback([
                            '네이버 페이지 접속에 실패하였습니다.',
                            '인터넷 연결 상태를 확인해주세요.'
                        ].join('\n'));
                    }
                });
            });
        });
        phantomjs_node.create.apply(phantomjs_node, args);
    },
    function (naver, callback) { // 이미 로그인 돼있는지 체크
        naver.evaluate(function () {
            return !!document.getElementById('minime');
        }, function (result) {
            var already = !!result; // 로그인 여부
            callback(null, already, naver);
        });
    },
    function (already, naver, callback) { // 로그인 시도
        if (already) {
            console.log('이미 네이버 로그인이 되어있으므로 바로 채팅방 접속을 시도합니다.');
            callback(null, naver);
            return;
        }
        console.log('네이버 로그인 시도 중...');
        naver.evaluate(function (id, pw) {
            var loginFrame = document.getElementById('loginframe'); // 로그인 영역
            var loginDocument = loginFrame.contentWindow.document;
            var loginForm = loginDocument.getElementById('frmNIDLogin');
            var idInput = loginDocument.getElementById('id');
            var pwInput = loginDocument.getElementById('pw');
            var chkLog = loginDocument.getElementById('chk_log');
            idInput.value = id;
            pwInput.value = pw;
            chkLog.click(); // 로그인 상태 유지
            loginForm.submit();
            return 'success';
        }, function (result) {
            if (result == 'success') {
                setTimeout(function () { // 1초 기다렸다가 실행
                    console.log('로그인 폼 입력 및 제출 성공.');
                    naver.get('url', function (url) {
                        console.log('현재 페이지 주소:', url);
                        if (url == 'http://www.naver.com/') {
                            callback(null, naver);
                        } else if (url == 'https://nid.naver.com/nidlogin.login') {
                            callback([
                                '네이버 로그인을 실패하였습니다.',
                                '아이디와 비밀번호를 다시한번 확인해주세요',
                                '혹은 로그인 시도를 너무 자주 하여 자동입력 방지가 작동하는 중일 수 있으니 나중에 다시 시도해주세요.'
                            ].join('\n'));
                        } else {
                            callback([
                                '예상하지 못한 결과입니다.',
                                '현재 페이지 주소를 깃헙 저장소에 이슈로 남겨주시면 감사하겠습니다.',
                                '저장소 주소: https://github.com/disjukr/never-cafe-chat/issues'
                            ].join('\n'));
                        }
                    });
                }, 1000);
            } else {
                callback([
                    '네이버 로그인 폼을 찾는데 실패하였습니다.',
                    '설정파일의 `user-agent` 값을 pc 환경으로 설정한 뒤 다시 시도해보세요.',
                    '그래도 문제가 있을 경우 깃헙 저장소에 이슈를 남겨주시면 감사하겠습니다.',
                    '저장소 주소: https://github.com/disjukr/never-cafe-chat/issues'
                ].join('\n'));
            }
        }, config.naver.id, config.naver.pw);
    },
    function (naver, callback) { // 카페 채팅 접속 시도
        naver.close(); // 로그인에 사용한 페이지는 닫음
        console.log('채팅방 접속 시도 중...');
        var naverCafeChat;
        phantom.createPage(function (page) {
            naverCafeChat = page;
            naverCafeChat.set('settings.userAgent', config['user-agent']);
            naverCafeChat.open(config.naver['chat-room'], function (status) {
                if (status == 'success') {
                    console.log('채팅방 접속 성공.');
                    naverCafeChat.evaluate(function () {
                        // 참여자 보기 클릭
                        var showRoomMemberListViewButton = document.getElementsByClassName('_click(ChatRoom|ShowRoomMemberListView)')[0];
                        function clickElement(el) { // workaround: http://stackoverflow.com/a/16803781/1711246
                            var ev = document.createEvent("MouseEvent");
                            ev.initMouseEvent(
                                'click', true, true, window, null,
                                0, 0, 0, 0, false,
                                false, false, false, 0, null
                            );
                            el.dispatchEvent(ev);
                        };
                        clickElement(showRoomMemberListViewButton);
                    });
                    setTimeout(function () { // 1초 기다렸다가 채팅방 정보 출력후 로깅 시작
                        callback(null, naverCafeChat);
                    }, 1000);
                } else {
                    callback([
                        '카페 채팅방 접속에 실패하였습니다.',
                        '인터넷 연결 상태를 확인해주세요.',
                        '인터넷 연결 상태에 문제가 없을 경우, 채팅방 주소가 올바른지 확인해 주세요.'
                    ].join('\n'));
                }
            });
        });
    },
    function (naverCafeChat, callback) { // 채팅방 정보
        getRoomInfo(naverCafeChat, function (roomInfo) {
            console.log('채팅방 정보:', roomInfo);
            callback(null, naverCafeChat);
        });
    },
    function (naverCafeChat, callback) { // 네이버 카페 채팅 로깅
        console.log('지금부터 네이버 카페 채팅이 로깅됩니다.');
        var fnwrap = function(target) { // workaround: https://github.com/sgentle/phantomjs-node/issues/4
            return function() {
                return target.apply(this, arguments);
            };
        }
        naverCafeChat.set('onCallback', fnwrap(function (data) {
            cafeChatQueue.push(data); // 큐에 쌓음
            console.log('카페 채팅:', data);
        }));
        naverCafeChat.evaluate(function () {
            if (typeof window.callPhantom !== 'function')
                throw 'error';
            var chatBoard = document.getElementById('boardBody');
            var lastChild = chatBoard.lastChild;
            setInterval(function () { // 초당 100 번씩 새 대화 체크
                if (lastChild != chatBoard.lastChild) { // 새 대화 발생
                    lastChild = chatBoard.lastChild; // 갱신
                    switch (lastChild.className) {
                    case 'msg': // 다른 사람의 대화
                        callPhantom({
                            type: 'message',
                            id: (function () {
                                return lastChild.attributes.targetId.value;
                            })(),
                            name: (function () {
                                var name = $$('.name', lastChild);
                                return (name.length > 0) ? name[0].textContent : '';
                            })(),
                            message: (function () {
                                var message = $$('.blm span', lastChild);
                                return (message.length > 0) ? message[0].textContent : '';
                            })()
                        });
                        break;
                    case 'my msg': // 내 대화
                        callPhantom({
                            type: 'my_message',
                            message: (function () {
                                var message = $$('.blm span', lastChild);
                                return (message.length > 0) ? message[0].textContent : '';
                            })()
                        });
                        break;
                    case undefined:
                        break;
                    default:
                        callPhantom({
                            type: 'unknown',
                            className: lastChild.className
                        });
                        break;
                    }
                }
            }, 10);
        });
        callback(null, naverCafeChat);
    }
], function (err) {
    if (err) {
        console.log(err);
        process.exit(3);
    }
});

function getRoomInfo(naverCafeChat, callback) {
    naverCafeChat.evaluate(function () {
        var memberList = $$('#roomMemberListBody li');
        return {
            name: (function () {
                return $$('#roomName')[0].textContent;
            })(),
            members: (function () {
                return $$('#roomMemberListBody li .inr a').map(function (memberInfo) {
                    var memberInfoClassName = memberInfo.className;
                    var parsedMemberInfo = memberInfoClassName.match(/.+\((?:.+)\|(?:.+)\|(.+)\|(.+)\|(.*)\).+/);
                    parsedMemberInfo = Array.apply(null, parsedMemberInfo);
                    return {
                        id: parsedMemberInfo[1],
                        name: parsedMemberInfo[2],
                        profileImageUrl: parsedMemberInfo[3]
                    };
                });
            })(),
            adminId: (function () {
                var adminInfo = $$('#roomMemberListBody li.adm .inr a')[0];
                var adminInfoClassName = adminInfo.className;
                var parsedAdminInfo = adminInfoClassName.match(/.+\((?:.+)\|(?:.+)\|(.+)\|(?:.+)\|(?:.*)\).+/);
                return Array.apply(null, parsedAdminInfo)[1];
            })()
        }
    }, callback);
}

function talkToNaverCafeChat(naverCafeChat, message) {
    naverCafeChat.evaluate(function (message) {
        var messageInputArea = document.getElementById('msgInputArea');
        var sendButton = document.getElementsByClassName('_click(ChatRoom|SendMessage)')[0];
        messageInputArea.value = message;
        sendButton.click();
    }, function (result) {
        // do nothing
    }, message);
}
