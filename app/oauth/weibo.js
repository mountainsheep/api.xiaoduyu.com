
var request = require('request');
var xss = require('xss');
var async = require('async');
var JWT = require('../common/jwt');

var User = require('../models').User;
var Oauth = require('../models').Oauth;
// var mkdirs = require('../common/mkdirs');
// var Avatar = require('../api/v1/avatar');
var qiniu = require('../api/v1/qiniu');

var config = require('../../config');
// var Tools = require('../common/tools');
// var auth = require('../middlewares/auth');

var appConfig = {
  appid: config.oauth.weibo.appid,
  appSecret: config.oauth.weibo.appSecret,
  redirectUri: config.domain+'/oauth/weibo-signin',
  scope: ''
}

var goToNoticePage = function(req, res, string) {
  var landingPage = req.cookies['landing_page'] || config.oauth.landingPage;
  res.redirect(config.oauth.landingPage+'/notice?source=oauth_weibo&notice='+string)
}

var goToAutoSignin = function(req, res, jwtTokenSecret, userId, accessToken) {
  var result = JWT.encode(jwtTokenSecret, userId, accessToken);
  var landingPage = req.cookies['landing_page'] || config.oauth.landingPage;
  res.redirect(config.oauth.landingPage+'/oauth?access_token='+result.access_token+'&expires='+result.expires)
}

// 授权页面
exports.show = function(req, res, next) {
  var csrf = Math.round(900000*Math.random()+100000);

  var opts = {
    httpOnly: true,
    path: '/',
    maxAge: 1000 * 60 * 5
  };
  res.cookie('csrf', csrf, opts);
  res.cookie('access_token', req.query.access_token || '', opts);
  res.cookie('landing_page', req.query.landing_page || '', opts);

  // req.session.csrf = csrf;
  // req.session.access_token = req.query.access_token || '';
  res.redirect('https://api.weibo.com/oauth2/authorize?response_type=code&state='+csrf+'&client_id='+appConfig.appid+'&redirect_uri='+encodeURIComponent(appConfig.redirectUri)+'&scope='+appConfig.scope);
};


// 验证登录
exports.signin = function(req, res, next) {

  var user = req.user;
  var code = req.query.code;
  var state = req.query.state;
  var user_access_token = req.cookies['access_token']; //req.session.access_token;

  // 避免csrf攻击
  if (req.cookies['csrf'] != state) {
    res.redirect(config.domain+'/oauth/weibo');
    return;
  }

  // var opts = {
  //   httpOnly: true,
  //   path: '/',
  //   maxAge: -1
  // };
  // res.cookie('access_token', '', opts);
  // res.cookie('csrf', '', opts);

  async.waterfall([

    function(callback) {

      // 如果带有 access_token 那么，判断 access_token 是否有效

      if (!user_access_token) {
        callback(null)
        return
      }

      var decoded = JWT.decode(user_access_token, req.jwtTokenSecret);

      if (decoded && decoded.expires > new Date().getTime()) {

        // 判断 token 是否有效
        User.fetch({ _id: decoded.user_id }, {}, {}, function(err, user){
          if (err) console.log(err);
          if (user && user[0]) {
            req.user = user[0];
            callback(null);
          } else {
            goToNoticePage(req, res, 'wrong_token');
            // callback(false);
          }
        });
      } else {
        goToNoticePage(req, res, 'wrong_token');
        // callback(false)
      }

      /*
      User.fetchByAccessToken(user_access_token, function(err, _user){
        if (err) console.log(err)
        if (_user) {
          user = _user
          callback(null)
        } else {
          goToNoticePage(req, res, 'wrong_token')
        }
      })
      */

    },

    function(callback) {
      // 获取用户信息
      getAccessToken(code, function(userInfo){
        if (userInfo) {
          callback(null, userInfo);
        } else {
          // 获取不到则转转到登录页面
          res.redirect(appConfig.redirectUri);
        }
      });
    },

    function(userInfo, callback) {
      // 查询 oauth 是否存在
      Oauth.fetchByOpenIdAndSource(userInfo.uid, 'weibo', function(err, oauth){
        if (err) console.log(err);
        callback(null, userInfo, oauth);
      });
    },

    function(userInfo, oauth, callback) {

      if (user && oauth && oauth.deleted == false) {
        // 已经绑定
        goToNoticePage(req, res, 'binding_failed')
      } else if (user && oauth && oauth.deleted == true) {

        // 已经存在的 oauth

        Oauth.updateById(oauth._id, {
          access_token: userInfo.access_token,
          expires_in: userInfo.expires_in,
          refresh_token: userInfo.remind_in,
          user_id: userInfo.uid,
          deleted: false
        }, function(err){
          if (err) {
            console.log(err)
            goToNoticePage(req, res, 'binding_failed')
          } else {
            goToNoticePage(req, res, 'binding_finished')
          }
        })

      } else if (user && !oauth) {

        // 绑定账户
        var weibo = {
          access_token: userInfo.access_token,
          expires_in: userInfo.expires_in,
          refresh_token: userInfo.remind_in,
          openid: userInfo.uid,
          source: 'weibo',
          user_id: user._id
        };

        Oauth.create(weibo, function(err, user){
          if (err) console.log(err);
          goToNoticePage(req, res, 'binding_finished')
        });

      } else if (!user && oauth && oauth.deleted == false) {
        // 登录
        goToAutoSignin(req, res, req.jwtTokenSecret, oauth.user_id._id, oauth.user_id.access_token)
      } else if (!user && !oauth) {

        // 创建 oauth 并登陆
        getUserInfo(userInfo.access_token, userInfo.uid, function(info) {

          var user = {
            nickname: info.screen_name,
            gender: (info.gender === 'm' ? 1 : 0),
            avatar: info.avatar_hd,
            access_token: userInfo.access_token,
            expires_in: userInfo.expires_in,
            // refresh_token: userInfo.remind_in,
            openid: userInfo.uid,
            createDate: new Date(),
            source: 4
          };

          createUser(user, function(newUser){

            if (!newUser) {
              goToNoticePage(req, res, 'create_user_failed')
              return
            }

            createOauth(user, newUser, function(oauth){
              if (oauth) {

                qiniu.uploadImage(user.avatar, newUser._id, function(){
                  goToAutoSignin(req, res, req.jwtTokenSecret, newUser._id, newUser.access_token)
                })

                // updateAvatar(user.avatar, newUser, function(){
                //   goToAutoSignin(res, req.jwtTokenSecret, newUser._id)
                // })
              } else {
                goToNoticePage(req, res, 'create_oauth_failed')
              }
            })

          })

        });

      } else if (!user && oauth && oauth.deleted == true) {

        // 创建 oauth 并登陆
        getUserInfo(userInfo.access_token, userInfo.uid, function(info) {

          var user = {
            nickname: info.screen_name,
            gender: (info.gender === 'm' ? 1 : 0),
            avatar: info.avatar_hd,
            access_token: userInfo.access_token,
            expires_in: userInfo.expires_in,
            // refresh_token: userInfo.remind_in,
            openid: userInfo.uid,
            createDate: new Date(),
            source: 4
          };

          createUser(user, function(newUser){
            if (newUser) {
              Oauth.updateById(oauth._id, { user_id: newUser._id, deleted: false }, function(){

                qiniu.uploadImage(user.avatar, newUser._id, function(){
                  goToAutoSignin(req, res, req.jwtTokenSecret, newUser._id, newUser.access_token)
                })

                // updateAvatar(user.avatar, newUser, function(){
                //   goToAutoSignin(res, req.jwtTokenSecret, newUser._id)
                // })
              })
            } else {
              goToNoticePage(req, res, 'create_oauth_failed')
            }
          })

        });

      }

    }

  ], function(err, user) {
    // res.redirect('/');
  });

};


// 解除绑定
exports.unbinding = function(req, res, next) {

  var access_token = req.body.access_token

  async.waterfall([
    function(callback) {

      var decoded = JWT.decode(access_token, req.jwtTokenSecret);

      if (decoded && decoded.expires > new Date().getTime()) {
        // 判断 token 是否有效
        User.fetch({ _id: decoded.user_id }, {}, {}, function(err, user){
          if (err) console.log(err);
          if (user && user[0]) {
            callback(null, user[0]);
          } else {
            callback('access token error');
          }
        });
      } else {
        callback('access token error');
      }

      /*
      // 是否有效的 access_token
      User.fetchByAccessToken(access_token, function(err, user){
        if (err) console.log(err)
        if (user) {
          callback(null, user)
        } else {
          callback('access token error')
        }
      })
      */
    },
    function(user, callback) {
      // 查询是否存在
      Oauth.fetchByUserIdAndSource(user._id, 'weibo', function(err, oauth){
        if (err) console.log(err);
        if (!oauth) {
          callback('not binding weibo');
        } else {
          callback(null, oauth);
        }
      });
    },
    function(oauth, callback) {
      // 标记删除状态
      Oauth.updateDeleteStatus(oauth._id, true, function(err){
        if (err) {
          console.log(err);
          callback('unbinding failed');
        } else {
          callback(null);
        }
      });
    }
  ], function(err, result){

    if (err) {
      res.status(401);
      res.send({
        success: false,
        error: err
      });
    } else {
      res.send({
        success: true
      });
    }

  });

};


// 获取token
var getAccessToken = function(code, callback) {

  request.post(
    'https://api.weibo.com/oauth2/access_token?client_id='+appConfig.appid+'&client_secret='+appConfig.appSecret+'&grant_type=authorization_code&redirect_uri='+encodeURIComponent(appConfig.redirectUri)+'&code='+code,
    {},
    function (error, response, body) {
      if (!error && response.statusCode == 200) {
        var info = JSON.parse(body);
        callback(info);
      } else {
        callback(null);
      }
    }
  );

};

// 获取用户信息
var getUserInfo = function(accessToken, uid, callback) {

  request.get(
    'https://api.weibo.com/2/users/show.json?access_token='+accessToken+'&uid='+uid+'&source='+appConfig.appid,
    {},
    function (error, response, body) {
      if (!error && response.statusCode == 200) {
        var info = JSON.parse(body);
        callback(info);
      } else {
        callback(null);
      }
    }
  );

};

/*
var getEmail = function(accessToken, uid, callback) {

  request.get(
    'https://api.weibo.com/2/account/profile/email.json?access_token='+accessToken+'&uid='+uid+'&source='+appConfig.appid,
    {},
    function (error, response, body) {
      if (!error && response.statusCode == 200) {
        var info = JSON.parse(body);
        callback(info);
      } else {
        callback(null);
      }
    }
  );

};
*/

// 通过日期获取头像的存放路径
var avatarFolderPath = function(date) {

  var myDate = new Date(date);
  var year = myDate.getFullYear();
  var month = (myDate.getMonth()+1);
  var day = myDate.getDate();

  if (month < 10) month = '0'+month;
  if (day < 10) day = '0'+day;

  return year + '/' + month + '/' + day + '/';
};

var createUser = function(user, callback) {

  // xss过滤
  user.nickname = xss(user.nickname, {
    whiteList: {},
    stripIgnoreTag: true,
    onTagAttr: function (tag, name, value, isWhiteAttr) {
      return '';
    }
  });

  // 创建用户
  User.create(user, function(err, newUser){
    if (err) console.log(err);
    callback(newUser)
  });

}

var createOauth = function(user, newUser, callback) {

  user.user_id = newUser._id;
  user.source = 'weibo';

  Oauth.create(user, function(err, oauth){
    if (err) console.log(err);
    callback(oauth);

  });

}

/*
var updateAvatar = function(imageSource, user, callback) {

  var path = config.upload.avatar.path + avatarFolderPath(user.create_at);

  // 创建文件夹
  mkdirs(path, 0755, function(){
    // 下载头像图片
    Tools.download(imageSource, path, user._id + "_original.jpg", function(){
      // 裁剪头像
      Avatar.cropAvatar(null, 0, 0, 180, 180, user, function(){
        callback();
      });
    });
  });

}


// 创建账户
var createAccount = function(req, user, callback) {

  // xss过滤
  user.nickname = xss(user.nickname, {
    whiteList: {},
    stripIgnoreTag: true,
    onTagAttr: function (tag, name, value, isWhiteAttr) {
      return '';
    }
  });

  User.create(user, function(err, newUser){
    if (err) console.log(err);
    user.user_id = newUser._id;
    user.source = 'weibo';
    Oauth.create(user, function(){
      if (err) console.log(err);

      var path = config.upload.avatar.path + avatarFolderPath(newUser.create_at);

      // 创建文件夹
      mkdirs(path, 0755, function(){
        // 下载头像图片
        // 头像图片一定要存成 _original.jpg
        Tools.download(user.avatar, path, newUser._id + "_original.jpg", function(){
          // 裁剪头像
          Avatar.cropAvatar(req, 0, 0, 180, 180, newUser, function(){
            callback(newUser);
          });
        });
      });

    });
  });

};
*/
