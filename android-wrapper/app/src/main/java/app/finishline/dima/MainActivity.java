package app.finishline.dima;

import android.Manifest;
import android.annotation.SuppressLint;
import android.app.Activity;
import android.content.ContentUris;
import android.content.Intent;
import android.content.pm.PackageManager;
import android.database.Cursor;
import android.net.Uri;
import android.os.Build;
import android.os.Bundle;
import android.provider.ContactsContract;
import android.provider.MediaStore;
import android.webkit.JavascriptInterface;
import android.webkit.PermissionRequest;
import android.webkit.WebChromeClient;
import android.webkit.WebResourceRequest;
import android.webkit.WebSettings;
import android.webkit.WebView;
import android.webkit.WebViewClient;
import android.widget.Toast;

import org.json.JSONObject;

public class MainActivity extends Activity {
    private static final String APP_URL = "https://finish-line-dev.lovable.app/";
    private static final String APP_HOST = "finish-line-dev.lovable.app";
    private static final int REQUEST_CONTACTS = 2001;
    private static final int REQUEST_AUDIO = 2002;
    private WebView webView;
    private PermissionRequest pendingPermissionRequest;
    private JSONObject pendingNativeCommand;

    private final class DimaBridge {
        @JavascriptInterface
        public void execute(String json) {
            try {
                JSONObject command = new JSONObject(json);
                runOnUiThread(() -> executeNativeCommand(command));
            } catch (Exception exception) {
                runOnUiThread(() -> toast("Не удалось разобрать голосовую команду."));
            }
        }
    }

    @SuppressLint("SetJavaScriptEnabled")
    @Override
    protected void onCreate(Bundle savedInstanceState) {
        super.onCreate(savedInstanceState);
        webView = new WebView(this);
        setContentView(webView);
        WebSettings settings = webView.getSettings();
        settings.setJavaScriptEnabled(true);
        settings.setDomStorageEnabled(true);
        settings.setMediaPlaybackRequiresUserGesture(false);
        settings.setAllowFileAccess(false);
        settings.setAllowContentAccess(false);
        settings.setMixedContentMode(WebSettings.MIXED_CONTENT_NEVER_ALLOW);
        webView.addJavascriptInterface(new DimaBridge(), "DimaAndroid");

        webView.setWebViewClient(new WebViewClient() {
            @Override
            public boolean shouldOverrideUrlLoading(WebView view, WebResourceRequest request) {
                Uri uri = request.getUrl();
                String host = uri.getHost();
                if ("https".equalsIgnoreCase(uri.getScheme()) && APP_HOST.equals(host)) return false;
                if ("https".equalsIgnoreCase(uri.getScheme()) || "http".equalsIgnoreCase(uri.getScheme())) {
                    startActivity(new Intent(Intent.ACTION_VIEW, uri));
                    return true;
                }
                return true;
            }
        });
        webView.setWebChromeClient(new WebChromeClient() {
            @Override
            public void onPermissionRequest(PermissionRequest request) {
                Uri origin = request.getOrigin();
                boolean trustedOrigin = origin != null && "https".equals(origin.getScheme()) && APP_HOST.equals(origin.getHost());
                boolean requestsAudio = false;
                for (String resource : request.getResources()) {
                    if (PermissionRequest.RESOURCE_AUDIO_CAPTURE.equals(resource)) requestsAudio = true;
                }
                if (!trustedOrigin || !requestsAudio) { request.deny(); return; }
                if (checkSelfPermission(Manifest.permission.RECORD_AUDIO) == PackageManager.PERMISSION_GRANTED) {
                    request.grant(new String[]{PermissionRequest.RESOURCE_AUDIO_CAPTURE});
                } else {
                    pendingPermissionRequest = request;
                    requestPermissions(new String[]{Manifest.permission.RECORD_AUDIO}, 1001);
                }
            }
        });
        if (savedInstanceState != null) webView.restoreState(savedInstanceState);
        else webView.loadUrl(APP_URL);
    }

    private void executeNativeCommand(JSONObject command) {
        String action = command.optString("action", "");
        switch (action) {
            case "camera": openCamera(); break;
            case "call":
                if (ensureContactsPermission(command)) return;
                openCall(command.optString("name", ""));
                break;
            case "sms":
                if (ensureContactsPermission(command)) return;
                openSms(command.optString("name", ""), command.optString("text", ""));
                break;
            case "contacts":
                String contactName = command.optString("name", "");
                if (contactName.isEmpty()) openContacts();
                else {
                    if (ensureContactsPermission(command)) return;
                    openCall(contactName);
                }
                break;
            case "music":
                if (ensureAudioPermission(command)) return;
                playLocalMusic(command.optString("query", ""));
                break;
            default: toast("Эта голосовая команда пока не поддерживается.");
        }
    }

    private boolean ensureContactsPermission(JSONObject command) {
        if (Build.VERSION.SDK_INT >= 23 && checkSelfPermission(Manifest.permission.READ_CONTACTS) != PackageManager.PERMISSION_GRANTED) {
            pendingNativeCommand = command;
            requestPermissions(new String[]{Manifest.permission.READ_CONTACTS}, REQUEST_CONTACTS);
            return true;
        }
        return false;
    }

    private boolean ensureAudioPermission(JSONObject command) {
        String permission = Build.VERSION.SDK_INT >= 33 ? Manifest.permission.READ_MEDIA_AUDIO : Manifest.permission.READ_EXTERNAL_STORAGE;
        if (Build.VERSION.SDK_INT >= 23 && checkSelfPermission(permission) != PackageManager.PERMISSION_GRANTED) {
            pendingNativeCommand = command;
            requestPermissions(new String[]{permission}, REQUEST_AUDIO);
            return true;
        }
        return false;
    }

    private void openCamera() {
        Intent intent = new Intent(MediaStore.ACTION_IMAGE_CAPTURE);
        launch(intent, "Не найдено приложение камеры.");
    }

    private void openContacts() {
        launch(new Intent(Intent.ACTION_VIEW, ContactsContract.Contacts.CONTENT_URI), "Не удалось открыть контакты.");
    }

    private void openCall(String name) {
        String number = findPhoneNumber(name);
        if (number == null) {
            if (name.matches("[+0-9() .-]{5,}")) number = name;
            else { toast("Контакт «" + name + "» не найден. Проверьте имя и разрешение на контакты."); return; }
        }
        launch(new Intent(Intent.ACTION_DIAL, Uri.parse("tel:" + Uri.encode(number))), "Не удалось открыть набор номера.");
    }

    private void openSms(String name, String text) {
        if (text.trim().isEmpty()) { toast("Текст SMS пустой, отправка отменена."); return; }
        String number = findPhoneNumber(name);
        if (number == null) {
            if (name.matches("[+0-9() .-]{5,}")) number = name;
            else { toast("Контакт «" + name + "» не найден. Сообщение не открыто."); return; }
        }
        Intent intent = new Intent(Intent.ACTION_SENDTO, Uri.parse("smsto:" + Uri.encode(number)));
        intent.putExtra("sms_body", text);
        launch(intent, "Не найдено приложение для SMS.");
    }

    private String findPhoneNumber(String name) {
        if (name == null || name.trim().isEmpty()) return null;
        Cursor cursor = null;
        try {
            cursor = getContentResolver().query(
                ContactsContract.CommonDataKinds.Phone.CONTENT_URI,
                new String[]{ContactsContract.CommonDataKinds.Phone.NUMBER, ContactsContract.CommonDataKinds.Phone.DISPLAY_NAME},
                ContactsContract.CommonDataKinds.Phone.DISPLAY_NAME + " LIKE ?",
                new String[]{"%" + name.trim() + "%"},
                ContactsContract.CommonDataKinds.Phone.DISPLAY_NAME + " ASC"
            );
            if (cursor != null && cursor.moveToFirst()) return cursor.getString(0);
        } catch (Exception exception) {
            toast("Не удалось прочитать контакты.");
        } finally {
            if (cursor != null) cursor.close();
        }
        return null;
    }

    private void playLocalMusic(String query) {
        Cursor cursor = null;
        try {
            Uri collection = MediaStore.Audio.Media.EXTERNAL_CONTENT_URI;
            cursor = getContentResolver().query(
                collection,
                new String[]{MediaStore.Audio.Media._ID, MediaStore.Audio.Media.TITLE},
                MediaStore.Audio.Media.IS_MUSIC + " != 0 AND " + MediaStore.Audio.Media.TITLE + " LIKE ?",
                new String[]{"%" + query.trim() + "%"},
                MediaStore.Audio.Media.TITLE + " ASC"
            );
            if (cursor != null && cursor.moveToFirst()) {
                long id = cursor.getLong(0);
                String title = cursor.getString(1);
                Uri audioUri = ContentUris.withAppendedId(collection, id);
                Intent intent = new Intent(Intent.ACTION_VIEW);
                intent.setDataAndType(audioUri, "audio/*");
                intent.addFlags(Intent.FLAG_GRANT_READ_URI_PERMISSION);
                toast("Открываю: " + title);
                launch(intent, "Не найден музыкальный плеер.");
            } else {
                toast("Не нашёл эту песню в локальной музыкальной библиотеке.");
            }
        } catch (Exception exception) {
            toast("Не удалось найти аудиофайл.");
        } finally {
            if (cursor != null) cursor.close();
        }
    }

    private void launch(Intent intent, String error) {
        try {
            if (intent.resolveActivity(getPackageManager()) != null) startActivity(intent);
            else toast(error);
        } catch (Exception exception) {
            toast(error);
        }
    }

    private void toast(String message) {
        Toast.makeText(this, message, Toast.LENGTH_LONG).show();
    }

    @Override
    public void onRequestPermissionsResult(int requestCode, String[] permissions, int[] grantResults) {
        super.onRequestPermissionsResult(requestCode, permissions, grantResults);
        if (requestCode == 1001 && pendingPermissionRequest != null) {
            if (grantResults.length > 0 && grantResults[0] == PackageManager.PERMISSION_GRANTED) pendingPermissionRequest.grant(new String[]{PermissionRequest.RESOURCE_AUDIO_CAPTURE});
            else pendingPermissionRequest.deny();
            pendingPermissionRequest = null;
            return;
        }
        if (requestCode == REQUEST_CONTACTS || requestCode == REQUEST_AUDIO) {
            JSONObject command = pendingNativeCommand;
            pendingNativeCommand = null;
            if (grantResults.length > 0 && grantResults[0] == PackageManager.PERMISSION_GRANTED && command != null) executeNativeCommand(command);
            else toast("Без этого разрешения команда не выполнена.");
        }
    }

    @Override
    protected void onSaveInstanceState(Bundle outState) {
        if (webView != null) webView.saveState(outState);
        super.onSaveInstanceState(outState);
    }

    @Override
    public void onBackPressed() {
        if (webView != null && webView.canGoBack()) webView.goBack();
        else super.onBackPressed();
    }

    @Override
    protected void onDestroy() {
        if (webView != null) { webView.destroy(); webView = null; }
        super.onDestroy();
    }
}
