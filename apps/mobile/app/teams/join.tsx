import {router,useLocalSearchParams} from 'expo-router';
import {useEffect,useRef,useState} from 'react';
import {ActivityIndicator,KeyboardAvoidingView,Platform,Pressable,ScrollView,Text,TextInput} from 'react-native';
import {SafeAreaView} from 'react-native-safe-area-context';
import {AppHeader} from '@/components/headers/app-header';
import {colors,fonts} from '@/constants/theme';
import {apiRequest,ApiError} from '@/lib/api';
import {useAuth} from '@/lib/auth';
export default function TeamJoinScreen(){
 const {code}=useLocalSearchParams<{code?:string}>();const {sessionToken}=useAuth();
 const [value,setValue]=useState(code??''),[busy,setBusy]=useState(false),[error,setError]=useState<string|null>(null);
 const lock=useRef(false),currentToken=useRef(sessionToken);currentToken.current=sessionToken;
 useEffect(()=>{setValue(code??'');setError(null);},[code]);
 async function join(){if(!sessionToken||lock.current||value.trim().length<4)return;lock.current=true;setBusy(true);setError(null);
  try{const team=await apiRequest<{id:string}>('/teams/join',{token:sessionToken,method:'POST',body:JSON.stringify({invite_code:value.trim()})});if(currentToken.current===sessionToken)router.replace({pathname:'/teams/[teamId]/home',params:{teamId:team.id}});}
  catch(e){if(currentToken.current===sessionToken)setError(e instanceof ApiError?e.message:'Could not join. Check the code and try again.');}finally{lock.current=false;setBusy(false);}
 }
 return <SafeAreaView style={{flex:1,backgroundColor:colors.background}} edges={[]}><AppHeader variant="detail" leftKind="back" title="Join a Watch Team"/><KeyboardAvoidingView style={{flex:1}} behavior={Platform.OS==='ios'?'padding':undefined}><ScrollView keyboardShouldPersistTaps="handled" contentContainerStyle={{padding:24,gap:20,maxWidth:600,width:'100%',alignSelf:'center'}}><Text style={{fontSize:28,fontFamily:fonts.serifBold,color:colors.ink}}>Watch better together.</Text><Text style={{fontSize:16,color:colors.muted}}>Enter the invitation code from your team. Joining gives you access to its private discussions and shared titles.</Text><TextInput accessibilityLabel="Invitation code" placeholder="Invitation code" placeholderTextColor={colors.muted} value={value} onChangeText={setValue} autoCapitalize="none" autoCorrect={false} maxLength={32} style={{fontSize:18,color:colors.ink,minHeight:52,padding:14,borderWidth:1,borderColor:colors.muted2,borderRadius:8}}/>{error?<Text accessibilityRole="alert" style={{fontSize:16,color:colors.accent}}>{error}</Text>:null}<Pressable disabled={busy||value.trim().length<4} onPress={()=>void join()} style={{minHeight:48,justifyContent:'center'}}>{busy?<ActivityIndicator color={colors.accent}/>:<Text style={{fontSize:17,color:colors.accent}}>Join team</Text>}</Pressable></ScrollView></KeyboardAvoidingView></SafeAreaView>;
}
