
var mongoose = require('mongoose');
var Schema = mongoose.Schema;
var ObjectId = Schema.Types.ObjectId;

var OauthSchema = new Schema({
  // 用户的唯一id
  openid: String,
  // 访问令牌
  access_token: String,
  // 令牌有效时间/单位秒
  expires_in: Number,
  // 刷新令牌
  refresh_token: String,
  /*
   * 用户注册来源
   * 0 -> qq
   * 1 -> weibo
   * 2 -> weixin
   */
  source: { type: Number, default: 0 },
  // 对应的用户信息
  user_id: { type: ObjectId, ref: 'User' },
  create_at: { type: Date, default: Date.now },
  deleted: { type: Boolean, default: false }
});

OauthSchema.index({ openid: 1 }, { unique: true });
OauthSchema.index({ openid: 1, source: 1 }, { unique: true });
OauthSchema.index({ openid: 1, source: 1, user_id: 1 }, { unique: true });

mongoose.model('Oauth', OauthSchema);
