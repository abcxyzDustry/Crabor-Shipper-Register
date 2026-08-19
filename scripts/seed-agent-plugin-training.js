/* Seed training entries for CRABOR Agent (web) so it answers "viết 1 plugin cơ bản" correctly. */
require('dotenv').config();
const mongoose = require('mongoose');

const trainingQaSchema = new mongoose.Schema({
  agent:    { type: String, enum: ['agent', 'coco', 'all'], default: 'agent' },
  question: { type: String, required: true },
  answer:   { type: String, required: true },
  category: { type: String, default: 'general' },
  enabled:  { type: Boolean, default: true },
}, { timestamps: true });
const TrainingQA = mongoose.models.TrainingQA || mongoose.model('TrainingQA', trainingQaSchema);

const ANSWER_BASIC_PLUGIN = `Dưới đây là TOÀN BỘ 3 file của một plugin Mindustry cơ bản (plugin chào hỏi khi người chơi nói "hi"). Copy nguyên văn từng file vào project của bạn — không viết tắt, không thay thế.

1) build.gradle
\`\`\`
plugins { id 'java' }
repositories { mavenCentral() }
dependencies { compileOnly files('Mindustry.jar') }
sourceSets.main.java.srcDirs = ['src']
tasks.jar { archiveFileName = 'MyPlugin.jar' }
\`\`\`

2) src/myplugin/MyPlugin.java
\`\`\`
package myplugin;
import arc.util.Log;
import mindustry.gen.Call;
import mindustry.mod.Plugin;

public class MyPlugin extends Plugin {
    @Override
    public void init() {
        Log.info("[MyPlugin] plugin loaded");
    }

    @Override
    public void registerServerCommands(arc.util.CommandHandler handler) {
        handler.register("hi", "Chào người chơi", (String[] args) -> {
            Log.info("[MyPlugin] hi command used");
            Call.sendMessage("[green]Hello from MyPlugin!");
        });
    }
}
\`\`\`

3) plugin.json
\`\`\`
{ "name": "MyPlugin", "displayName": "MyPlugin", "author": "user", "main": "myplugin.MyPlugin", "description": "Plugin đơn giản tạo lệnh /hi", "version": "1.0" }
\`\`\`

QUING TRỌNG các điểm đã kiểm chứng khi build:
- KHÔNG dùng dependency \`com.github.Anuken.Mindustry:core\` (JitPack trả lỗi 401). Dùng chính file \`Mindustry.jar\` của game làm compileOnly như trên.
- Tải Mindustry.jar vào đúng thư mục project: \`curl -L -o Mindustry.jar https://github.com/Anuken/Mindustry/releases/download/v146/Mindustry.jar\`
- API chuẩn: \`Call.sendMessage\` để gửi tin nhắn (KHÔNG có \`Call.info\`), đăng ký lệnh qua \`handler.register\` trong \`registerServerCommands\`, \`Vars.netServer.clientCommands.register\` cũng hợp lệ. \`Vars.netServer\` là field (không phải method), không có \`addCommandHandler\` trên \`netServer.admins\`.
- Lệnh build: \`gradle build\` (hoặc \`gradlew build\`). Jar tạo ra tại \`build/libs/MyPlugin.jar\`, bỏ vào thư mục \`mods/\` của game.

⚠️ Nội dung do AI tạo, có thể có sai sót. Bạn nên kiểm tra lại.`;

const rows = [
  { agent: 'agent', category: 'plugin', question: 'viết 1 plugin cơ bản', answer: ANSWER_BASIC_PLUGIN },
  { agent: 'agent', category: 'plugin', question: 'tạo plugin cơ bản', answer: ANSWER_BASIC_PLUGIN },
  { agent: 'agent', category: 'plugin', question: 'viết plugin mindustry hello world', answer: ANSWER_BASIC_PLUGIN },
  { agent: 'agent', category: 'plugin', question: 'viết plugin cơ bản cho game', answer: ANSWER_BASIC_PLUGIN },
  { agent: 'agent', category: 'plugin', question: 'làm một plugin đơn giản', answer: ANSWER_BASIC_PLUGIN },
];

(async () => {
  try {
    await mongoose.connect(process.env.MONGODB_URI, { serverSelectionTimeoutMS: 15000, dbName: 'crabor' });
    const coll = TrainingQA.collection.name;
    let i = 0;
    for (const r of rows) {
      const exists = await TrainingQA.findOne({ agent: r.agent, question: { $regex: '^' + r.question.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + '$', $options: 'i' } }).lean();
      if (!exists) {
        await TrainingQA.create(r);
        i++;
        console.log('INSERTED:', r.question);
      } else {
        console.log('SKIP (exists):', r.question);
      }
    }
    console.log('Done. Inserted:', i, '/', rows.length, 'collection:', coll);
  } catch (e) {
    console.error('ERROR:', e.message);
    process.exitCode = 1;
  } finally {
    await mongoose.disconnect();
  }
})();