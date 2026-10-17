package app.finishline.dima;

import android.Manifest;
import android.app.*;
import android.content.*;
import android.content.pm.PackageManager;
import android.database.Cursor;
import android.media.MediaPlayer;
import android.net.Uri;
import android.os.*;
import android.provider.ContactsContract;
import android.provider.MediaStore;
import android.speech.*;
import android.speech.tts.TextToSpeech;
import android.speech.tts.UtteranceProgressListener;
import android.telecom.TelecomManager;
import android.telephony.SmsManager;
import android.util.Log;
import java.util.*;

public class OfflineAssistantService extends Service implements RecognitionListener {
    static final String ACTION_START = "app.finishline.dima.OFFLINE_START";
    static final String ACTION_STOP = "app.finishline.dima.OFFLINE_STOP";
    static final String EXTRA_LANGUAGE = "language";
    private static final String CHANNEL = "dima_offline";
    private static final int NOTIFICATION_ID = 4407;
    private static volatile boolean running;
    public static boolean isRunning() { return running; }

    private final Handler handler = new Handler(Looper.getMainLooper());
    private SpeechRecognizer recognizer;
    private TextToSpeech tts;
    private MediaPlayer player;
    private String localeTag = "ru-RU", smsRecipient, smsText;
    private boolean awaitingCommand, speaking;

    @Override public void onCreate() {
        super.onCreate();
        if (Build.VERSION.SDK_INT >= 26) {
            NotificationChannel channel = new NotificationChannel(CHANNEL, "Dima offline assistant", NotificationManager.IMPORTANCE_LOW);
            channel.setDescription("Локальное распознавание голосовых команд");
            getSystemService(NotificationManager.class).createNotificationChannel(channel);
        }
        tts = new TextToSpeech(this, status -> { if (status == TextToSpeech.SUCCESS) configureTts(); });
    }

    @Override public int onStartCommand(Intent intent, int flags, int startId) {
        if (intent != null && ACTION_STOP.equals(intent.getAction())) {
            getSharedPreferences("dima_offline", MODE_PRIVATE).edit().putBoolean("enabled", false).apply();
            stopAssistant();
            return START_NOT_STICKY;
        }
        if (intent != null && ACTION_START.equals(intent.getAction())) {
            localeTag = localeFor(intent.getStringExtra(EXTRA_LANGUAGE));
        } else {
            localeTag = getSharedPreferences("dima_offline", MODE_PRIVATE).getString("language", "ru-RU");
        }
        if (checkSelfPermission(Manifest.permission.RECORD_AUDIO) != PackageManager.PERMISSION_GRANTED ||
                Build.VERSION.SDK_INT < 31 || !SpeechRecognizer.isOnDeviceRecognitionAvailable(this)) {
            startForeground(NOTIFICATION_ID, notification("Офлайн-распознавание недоступно. Проверьте микрофон и установленный офлайн-языковой пакет."));
            running = false;
            stopSelf();
            return START_NOT_STICKY;
        }
        startForeground(NOTIFICATION_ID, notification("Офлайн-режим активен. Скажите «Дима» и команду."));
        running = true;
        listen();
        return START_STICKY;
    }

    private String localeFor(String value) {
        if ("be".equals(value)) return "be-BY";
        if ("pl".equals(value)) return "pl-PL";
        if ("en".equals(value)) return "en-US";
        if (value != null && value.contains("-")) return value;
        return "ru-RU";
    }

    private void listen() {
        if (!running || speaking) return;
        try {
            if (recognizer != null) { recognizer.destroy(); recognizer = null; }
            if (!SpeechRecognizer.isOnDeviceRecognitionAvailable(this)) { update("Офлайн-распознавание недоступно"); return; }
            recognizer = SpeechRecognizer.createOnDeviceSpeechRecognizer(this);
            recognizer.setRecognitionListener(this);
            Intent request = new Intent(RecognizerIntent.ACTION_RECOGNIZE_SPEECH);
            request.putExtra(RecognizerIntent.EXTRA_LANGUAGE_MODEL, RecognizerIntent.LANGUAGE_MODEL_FREE_FORM);
            request.putExtra(RecognizerIntent.EXTRA_LANGUAGE, localeTag);
            request.putExtra(RecognizerIntent.EXTRA_LANGUAGE_PREFERENCE, localeTag);
            request.putExtra(RecognizerIntent.EXTRA_PREFER_OFFLINE, true);
            request.putExtra(RecognizerIntent.EXTRA_PARTIAL_RESULTS, false);
            request.putExtra(RecognizerIntent.EXTRA_MAX_RESULTS, 2);
            recognizer.startListening(request);
        } catch (Exception e) { Log.w("DimaOffline", "Recognizer restart failed", e); restart(1600); }
    }
    private void restart(long delay) { handler.removeCallbacks(restartTask); if (running) handler.postDelayed(restartTask, delay); }
    private final Runnable restartTask = this::listen;

    @Override public void onReadyForSpeech(Bundle b) { }
    @Override public void onBeginningOfSpeech() { }
    @Override public void onRmsChanged(float v) { }
    @Override public void onBufferReceived(byte[] b) { }
    @Override public void onEndOfSpeech() { }
    @Override public void onPartialResults(Bundle b) { }
    @Override public void onEvent(int i, Bundle b) { }
    @Override public void onResults(Bundle bundle) {
        ArrayList<String> values = bundle == null ? null : bundle.getStringArrayList(SpeechRecognizer.RESULTS_RECOGNITION);
        if (values != null && !values.isEmpty()) process(values.get(0).trim());
        restart(550);
    }
    @Override public void onError(int error) {
        if (error == SpeechRecognizer.ERROR_LANGUAGE_NOT_SUPPORTED || error == SpeechRecognizer.ERROR_LANGUAGE_UNAVAILABLE) update("Нет офлайн-модели для " + localeTag + ". Скачайте язык в настройках распознавания речи Android.");
        restart(error == SpeechRecognizer.ERROR_RECOGNIZER_BUSY ? 1400 : 800);
    }

    private void process(String raw) {
        if (raw.isEmpty()) return;
        String text = raw.toLowerCase(Locale.ROOT).replace('ё','е').trim();
        if (smsRecipient != null && smsText == null) {
            smsText = raw;
            say("Текст сообщения: " + smsText + ". Получатель: " + smsRecipient + ". Скажите «Да, отправить» или «Отмена».");
            update("Проверьте текст SMS. Скажите «Да, отправить» или «Отмена».");
            return;
        }
        if (smsRecipient != null) {
            if (has(text,"да отправить","отправляй","подтверждаю","yes send","send it","wyślij","wyslij","так","адпраўляй") || text.equals("да") || text.equals("yes") || text.equals("tak")) {
                String recipient=smsRecipient, message=smsText; smsRecipient=null; smsText=null; sendSms(recipient,message);
            } else if (has(text,"отмена","отмени","не отправляй","cancel","anuluj","скасуй") || text.equals("no") || text.equals("nie")) {
                smsRecipient=null; smsText=null; say("Отменено. Сообщение не отправлено."); update("SMS отменено");
            } else say("Скажите «Да, отправить» или «Отмена».");
            return;
        }
        String command = stripWake(text);
        if (command != null) {
            awaitingCommand = command.isEmpty();
            if (!command.isEmpty()) execute(command, command);
            else update("Слушаю команду офлайн");
        } else if (awaitingCommand) {
            awaitingCommand=false; execute(text,raw);
        }
    }

    private String stripWake(String text) {
        String s=text.replaceAll("[,.:;!?]"," ").trim();
        for(String wake:new String[]{"дима","димон","dima","dimon","дзіма","дзiма"}) {
            if(s.equals(wake)) return "";
            if(s.startsWith(wake+" ")) return s.substring(wake.length()).trim();
        }
        return null;
    }
    private boolean has(String s,String... words) { for(String w:words) if(s.contains(w)) return true; return false; }
    private String stripPrefix(String s,String... prefixes) {
        String lower=s.toLowerCase(Locale.ROOT).trim();
        for(String p:prefixes) if(lower.startsWith(p.toLowerCase(Locale.ROOT))) return s.trim().substring(p.length()).replaceFirst("^[, :]+","").trim();
        return s.trim();
    }

    private void execute(String text,String raw) {
        if(has(text,"камер","camera","aparat")) { openCamera(); return; }
        if(has(text,"позвони","набери","патэлефануй","call ","zadzwoń","zadzwon")) {
            call(stripPrefix(stripPrefix(raw,"позвони","набери","патэлефануй","call","zadzwoń do","zadzwon do","zadzwoń","zadzwon"),"абоненту","контакту","to","do")); return;
        }
        if(has(text,"отправь сообщение","отправь смс","напиши сообщение","send a message","send message","send sms","wyślij wiadomość","wyslij wiadomosc","адпраў паведамленне","напішы паведамленне")) {
            String name=stripPrefix(raw,"отправь сообщение абоненту","отправь сообщение контакту","отправь сообщение","отправь смс абоненту","отправь смс контакту","отправь смс","напиши сообщение абоненту","напиши сообщение контакту","напиши сообщение","send a message to","send message to","send sms to","send a message","send message","send sms","wyślij wiadomość do","wyslij wiadomosc do","wyślij wiadomość","wyslij wiadomosc","адпраў паведамленне","напішы паведамленне");
            name=name.replaceFirst("^(?i)(абоненту|контакту|to|do)\\s+","").trim();
            if(name.isEmpty()) { update("Не распознал получателя SMS"); return; }
            smsRecipient=name; smsText=null; say("Продиктуйте текст сообщения для "+name); update("Жду текст SMS для "+name); return;
        }
        if(has(text,"включи музыку","включи песню","включи трек","включи в плеере","play ","odtwórz","włącz muzykę","włącz piosenkę","уключы музыку","прайграй")) {
            playMusic(stripPrefix(raw,"включи в плеере","включи песню","включи музыку","включи трек","play","odtwórz","włącz muzykę","włącz piosenkę","włącz","уключы музыку","прайграй")); return;
        }
        if(has(text,"открой контакты","покажи контакты","open contacts","otwórz kontakty","адкрый кантакты")) {
            launch(new Intent(Intent.ACTION_VIEW,ContactsContract.Contacts.CONTENT_URI),"Не удалось открыть контакты"); return;
        }
        update("Команда не распознана");
    }

    private String phone(String name) {
        if(checkSelfPermission(Manifest.permission.READ_CONTACTS)!=PackageManager.PERMISSION_GRANTED) return null;
        Cursor c=null;
        try {
            c=getContentResolver().query(ContactsContract.CommonDataKinds.Phone.CONTENT_URI,
              new String[]{ContactsContract.CommonDataKinds.Phone.NUMBER},
              ContactsContract.CommonDataKinds.Phone.DISPLAY_NAME+" LIKE ?",new String[]{"%"+name.trim()+"%"},
              ContactsContract.CommonDataKinds.Phone.DISPLAY_NAME+" ASC");
            if(c!=null&&c.moveToFirst()) return c.getString(0);
        } catch(Exception e){Log.w("DimaOffline","Contact search failed",e);} finally {if(c!=null)c.close();}
        return name.matches("[+0-9() .-]{5,}")?name:null;
    }
    private void call(String name) {
        String number=phone(name);
        if(number==null){update("Контакт не найден или нет разрешения на контакты");return;}
        if(checkSelfPermission(Manifest.permission.CALL_PHONE)!=PackageManager.PERMISSION_GRANTED){update("Откройте Dima и разрешите телефонные вызовы");return;}
        try {
            TelecomManager telecom=(TelecomManager)getSystemService(TELECOM_SERVICE);
            if(telecom!=null) telecom.placeCall(Uri.parse("tel:"+Uri.encode(number)),new Bundle());
            else {Intent i=new Intent(Intent.ACTION_CALL,Uri.parse("tel:"+Uri.encode(number)));i.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK);startActivity(i);}
            update("Выполняю звонок");
        } catch(Exception e){update("Android заблокировал вызов. Возможно, телефон нужно разблокировать.");}
    }
    private void openCamera() {
        try {Intent i=new Intent(MediaStore.ACTION_IMAGE_CAPTURE);i.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK);startActivity(i);update("Открываю камеру");}
        catch(Exception e){update("Android не разрешил запуск камеры с заблокированного экрана. Разблокируйте телефон.");}
    }
    private void playMusic(String query) {
        String permission=Build.VERSION.SDK_INT>=33?Manifest.permission.READ_MEDIA_AUDIO:Manifest.permission.READ_EXTERNAL_STORAGE;
        if(checkSelfPermission(permission)!=PackageManager.PERMISSION_GRANTED){update("Откройте Dima и разрешите доступ к музыке");return;}
        Cursor c=null;
        try {
            c=getContentResolver().query(MediaStore.Audio.Media.EXTERNAL_CONTENT_URI,new String[]{MediaStore.Audio.Media._ID,MediaStore.Audio.Media.TITLE},
              MediaStore.Audio.Media.IS_MUSIC+" != 0 AND "+MediaStore.Audio.Media.TITLE+" LIKE ?",new String[]{"%"+query.trim()+"%"},MediaStore.Audio.Media.TITLE+" ASC");
            if(c==null||!c.moveToFirst()){update("Песня не найдена среди локальных файлов");return;}
            Uri uri=ContentUris.withAppendedId(MediaStore.Audio.Media.EXTERNAL_CONTENT_URI,c.getLong(0));String title=c.getString(1);
            if(player!=null){player.release();player=null;}
            player=new MediaPlayer();player.setDataSource(this,uri);
            player.setOnPreparedListener(p->{p.start();update("Играет: "+title);});
            player.setOnErrorListener((p,w,e)->{update("Не удалось воспроизвести песню");return true;});player.prepareAsync();
        } catch(Exception e){update("Не удалось запустить локальную музыку");} finally {if(c!=null)c.close();}
    }
    private void sendSms(String name,String text) {
        String number=phone(name);
        if(number==null||text==null||text.trim().isEmpty()){update("SMS не отправлено: контакт или текст не найден");return;}
        if(checkSelfPermission(Manifest.permission.SEND_SMS)!=PackageManager.PERMISSION_GRANTED){update("Откройте Dima и разрешите SMS");return;}
        try {
            SmsManager manager=getSystemService(SmsManager.class);if(manager==null){update("SMS недоступны");return;}
            ArrayList<String> parts=manager.divideMessage(text);
            if(parts.size()<=1)manager.sendTextMessage(number,null,text,null,null);else manager.sendMultipartTextMessage(number,null,parts,null,null);
            update("SMS отправлено");say("Сообщение отправлено");
        } catch(Exception e){update("Не удалось отправить SMS. Проверьте SIM-карту и сеть");}
    }

    private void configureTts() {
        try {
            Locale locale=Locale.forLanguageTag(localeTag);
            for(android.speech.tts.Voice voice:tts.getVoices()) if(voice.getLocale().getLanguage().equals(locale.getLanguage())&&!voice.isNetworkConnectionRequired()){tts.setVoice(voice);break;}
        } catch(Exception ignored) {}
    }
    private void say(String text) {
        if(tts==null){update(text);return;}
        android.speech.tts.Voice offline=null;
        try {
            Locale locale=Locale.forLanguageTag(localeTag);
            for(android.speech.tts.Voice voice:tts.getVoices()) if(voice.getLocale().getLanguage().equals(locale.getLanguage())&&!voice.isNetworkConnectionRequired()){offline=voice;break;}
            if(offline==null){update(text);return;}
            tts.setVoice(offline);speaking=true;if(recognizer!=null)recognizer.cancel();
            tts.setOnUtteranceProgressListener(new UtteranceProgressListener(){
                @Override public void onStart(String id){}
                @Override public void onDone(String id){handler.post(()->{speaking=false;restart(350);});}
                @Override public void onError(String id){handler.post(()->{speaking=false;restart(350);});}
            });
            tts.speak(text,TextToSpeech.QUEUE_FLUSH,null,"dima-"+System.currentTimeMillis());
        } catch(Exception e){speaking=false;update(text);}
    }

    private void launch(Intent intent,String error) {
        try { intent.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK); startActivity(intent); }
        catch(Exception e) { update(error); }
    }

    private Notification notification(String text) {
        Intent open=new Intent(this,MainActivity.class);
        PendingIntent content=PendingIntent.getActivity(this,4408,open,PendingIntent.FLAG_UPDATE_CURRENT|PendingIntent.FLAG_IMMUTABLE);
        Intent stop=new Intent(this,OfflineAssistantService.class).setAction(ACTION_STOP);
        PendingIntent stopIntent=PendingIntent.getService(this,4409,stop,PendingIntent.FLAG_UPDATE_CURRENT|PendingIntent.FLAG_IMMUTABLE);
        Notification.Builder b=Build.VERSION.SDK_INT>=26?new Notification.Builder(this,CHANNEL):new Notification.Builder(this);
        return b.setSmallIcon(android.R.drawable.ic_btn_speak_now).setContentTitle("Дима · офлайн-режим").setContentText(text)
          .setContentIntent(content).setOngoing(true).addAction(new Notification.Action.Builder(null,"Выключить",stopIntent).build()).build();
    }
    private void update(String text) {try{NotificationManager m=getSystemService(NotificationManager.class);if(m!=null)m.notify(NOTIFICATION_ID,notification(text));}catch(Exception ignored){}}
    private void stopAssistant() {
        running=false;handler.removeCallbacksAndMessages(null);
        if(recognizer!=null){recognizer.cancel();recognizer.destroy();recognizer=null;}
        if(player!=null){player.release();player=null;}
        if(tts!=null){tts.stop();tts.shutdown();tts=null;}
        stopForeground(true);stopSelf();
    }
    @Override public void onDestroy(){running=false;handler.removeCallbacksAndMessages(null);if(recognizer!=null){recognizer.cancel();recognizer.destroy();}if(player!=null)player.release();if(tts!=null){tts.stop();tts.shutdown();}super.onDestroy();}
    @Override public IBinder onBind(Intent intent){return null;}
}
