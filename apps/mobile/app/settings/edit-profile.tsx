/**
 * Oct-18 UI/UX rebuild: Edit Profile sub-screen.
 * Spec image 4 (step 3). Avatar + cover + name + username + bio.
 */
import { Ionicons } from "@expo/vector-icons";
import { router } from "expo-router";
import { useEffect, useRef, useState } from "react";
import {
  ActivityIndicator,
  Alert,
  KeyboardAvoidingView,
  Platform,
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  TextInput,
  View,
} from "react-native";
import { SafeAreaView } from "react-native-safe-area-context";

import { pickImageForm } from "@/lib/image-upload";
import { AppHeader } from "@/components/headers/app-header";
import { Avatar } from "@/components/avatar";
import { colors, fonts, radii, spacing } from "@/constants/theme";
import { apiRequest } from "@/lib/api";
import { useAuth } from "@/lib/auth";


type Me = {
  user_id: string;
  username: string;
  display_name: string;
  bio: string | null;
  avatar_url: string | null;
};


export default function EditProfileScreen() {
  const { sessionToken, updateSessionUser } = useAuth();
  const [me, setMe] = useState<Me | null>(null);
  const [name, setName] = useState("");
  const [username, setUsername] = useState("");
  const [bio, setBio] = useState("");
  const [photoBusy,setPhotoBusy]=useState(false);
  const [error,setError]=useState<string|null>(null);
  const [saving, setSaving] = useState(false);
  const photoLock=useRef(false);
  const currentToken=useRef(sessionToken);currentToken.current=sessionToken;
  const [retry,setRetry]=useState(0);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    if (!sessionToken) return;
    let cancelled = false;setLoading(true);setError(null);setMe(null);
    apiRequest<Me>("/me", { token: sessionToken })
      .then((res) => {
        if (cancelled) return;
        setMe(res);
        setName(res.display_name ?? "");
        setUsername(res.username ?? "");
        setBio(res.bio ?? "");
      })
      .catch(() => {if(!cancelled)setError("Could not load your profile. Please retry.");})
      .finally(() => { if (!cancelled) setLoading(false); });
    return () => { cancelled = true; };
  }, [sessionToken,retry]);

  async function save() {
    if (!sessionToken || saving || photoBusy || !me) return;
    setSaving(true);
    try {
      const updated=await apiRequest<Me>("/me", {
        method: "PATCH",
        token: sessionToken,
        body: JSON.stringify({ display_name: name, username, bio }),
      });
      if(currentToken.current!==sessionToken)return;
      await updateSessionUser({display_name:updated.display_name,avatar_url:updated.avatar_url});
      router.back();
    } catch (err) {
      setError("Could not save those changes. Check your username and try again.");
    } finally {
      setSaving(false);
    }
  }

  async function changePhoto(remove=false){
    if(!sessionToken||photoLock.current||saving||!me)return;
    photoLock.current=true;
    setPhotoBusy(true);setError(null);
    try{
      const form=remove?null:await pickImageForm();
      if(!remove&&!form)return;
      const updated=await apiRequest<Me>('/me/avatar',{token:sessionToken,method:remove?'DELETE':'POST',body:form ?? undefined,timeoutMs:30000});
      if(currentToken.current!==sessionToken)return;
      setMe(updated);await updateSessionUser({avatar_url:updated.avatar_url});
    }catch(failure){setError(failure instanceof Error && !failure.message.startsWith('{')?failure.message:'Could not upload the picture. Your previous photo is unchanged.');}
    finally{photoLock.current=false;setPhotoBusy(false);}
  }

  return (
    <SafeAreaView style={styles.root} edges={[]}>
      <KeyboardAvoidingView style={{ flex: 1 }} behavior={Platform.OS === "ios" ? "padding" : undefined}>
        <AppHeader variant="detail" leftKind="back" title="Edit profile" rightSlot={<Pressable onPress={save} disabled={saving||photoBusy||!me} style={{minHeight:44,minWidth:44,justifyContent:'center'}}><Text style={styles.saveLabel}>{saving?'Saving…':'Save'}</Text></Pressable>}/>

        {loading ? (
          <View style={styles.center}>
            <ActivityIndicator color={colors.accent} />
          </View>
        ) : (
          <ScrollView contentContainerStyle={styles.body}>
            {!me?<Pressable style={{minHeight:44}} onPress={()=>setRetry(n=>n+1)}><Text style={styles.saveLabel}>Retry loading profile</Text></Pressable>:null}
            <View style={styles.avatarRow}>
              <Pressable style={styles.avatarWrap} disabled={photoBusy} onPress={()=>void changePhoto()} accessibilityRole="button" accessibilityLabel="Change profile picture">
                <Avatar uri={me?.avatar_url ?? null} label={me?.display_name ?? ""} size={80} />
                <View style={styles.avatarEdit}>
                  <Ionicons name="camera" size={14} color="#0b0f17" />
                </View>
              </Pressable>
              <Pressable style={styles.coverEdit} disabled={photoBusy} onPress={()=>void changePhoto()}>
                <Ionicons name="camera-outline" size={14} color={colors.ink} />
                <Text style={styles.coverEditLabel}>Change photo</Text>
              </Pressable>
            </View>

            {photoBusy ? <ActivityIndicator color={colors.accent}/> : null}
            {error ? <Text accessibilityRole="alert" style={{color:colors.accent,fontSize:16}}>{error}</Text> : null}
            {me?.avatar_url ? <Pressable style={{minHeight:44,justifyContent:"center"}} disabled={photoBusy} onPress={()=>void changePhoto(true)}><Text style={{color:colors.muted}}>Remove photo</Text></Pressable> : null}
            <Text style={styles.label}>Name</Text>
            <TextInput value={name} onChangeText={setName} style={styles.input} placeholderTextColor={colors.muted2} maxLength={50} />

            <Text style={styles.label}>Username</Text>
            <TextInput
              value={username}
              onChangeText={setUsername}
              style={styles.input}
              autoCapitalize="none"
              placeholderTextColor={colors.muted2}
              maxLength={40}
            />

            <Text style={styles.label}>Bio</Text>
            <TextInput
              value={bio}
              onChangeText={(t) => t.length <= 150 && setBio(t)}
              style={[styles.input, { minHeight: 80, textAlignVertical: "top" }]}
              multiline
              placeholderTextColor={colors.muted2}
              maxLength={150}
            />
            <Text style={styles.counter}>{bio.length}/150</Text>
          </ScrollView>
        )}
      </KeyboardAvoidingView>
    </SafeAreaView>
  );
}


const styles = StyleSheet.create({
  root: { flex: 1, backgroundColor: colors.background },
  header: {
    flexDirection: "row",
    alignItems: "center",
    paddingHorizontal: spacing.md,
    paddingVertical: spacing.sm,
    borderBottomWidth: StyleSheet.hairlineWidth,
    borderBottomColor: "rgba(255,255,255,0.08)",
  },
  closeBtn: { width: 36, height: 36, alignItems: "center", justifyContent: "center" },
  headerTitle: { flex: 1, textAlign: "center", fontFamily: fonts.sansSemiBold, color: colors.ink, fontSize: 15 },
  saveLabel: { fontFamily: fonts.sansSemiBold, color: colors.accent, fontSize: 14 },
  center: { flex: 1, alignItems: "center", justifyContent: "center" },
  body: { padding: spacing.lg, paddingBottom:100, gap: 10, width:"100%", maxWidth:720, alignSelf:"center" },
  avatarRow: { flexDirection: "row", alignItems: "center", justifyContent: "space-between", marginBottom: spacing.md },
  avatarWrap: { position: "relative" },
  avatarEdit: {
    position: "absolute",
    bottom: 0,
    right: 0,
    width: 26,
    height: 26,
    borderRadius: 13,
    backgroundColor: colors.accent,
    alignItems: "center",
    justifyContent: "center",
    borderWidth: 2,
    borderColor: colors.background,
  },
  coverEdit: {
    flexDirection: "row",
    alignItems: "center",
    gap: 6,
    paddingHorizontal: 10,
    paddingVertical: 8,
    borderRadius: radii.sm,
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: "rgba(255,255,255,0.18)",
  },
  coverEditLabel: { fontFamily: fonts.sansMedium, color: colors.ink, fontSize: 12 },
  label: {
    marginTop: 10,
    fontFamily: fonts.monoSemiBold,
    color: colors.muted,
    fontSize: 11,
    letterSpacing: 1,
  },
  input: {
    padding: spacing.sm,
    borderRadius: radii.md,
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: "rgba(255,255,255,0.14)",
    backgroundColor: colors.surface,
    color: colors.ink,
    fontFamily: fonts.sans,
    fontSize: 16,
  },
  counter: { textAlign: "right", fontFamily: fonts.monoMedium, color: colors.muted2, fontSize: 11 },
});
