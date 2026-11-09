import { useLocalSearchParams } from 'expo-router';
import { ListReader } from '@/components/list-reader';
export default function ListScreen(){ const {listId}=useLocalSearchParams<{listId:string}>(); return <ListReader endpoint={`/lists/${encodeURIComponent(listId ?? '')}`}/>; }
